/**
 * `MessageFieldExtractor` — streaming JSON path filter that emits ONLY the
 * characters inside the value of a top-level string field (default `message`).
 *
 * MJ loop-agent prompts stream a JSON envelope (`LoopAgentResponse`) like:
 *
 *   { "taskComplete": true, "message": "Hi there!", "reasoning": "...", ... }
 *
 * Downstream consumers (chat UI, voice TTS) want the human-readable prose —
 * the `message` value — NOT the surrounding JSON syntax, `reasoning`, or
 * `nextStep`. This extractor lets `BaseAgent` crack the prose out of the
 * partial JSON AS IT STREAMS and re-emit it as a native `text`
 * {@link AgentStreamBlock}, so nothing downstream ever parses JSON.
 *
 * This is the Loop agent's "legacy JSON → typed blocks" adapter, living at
 * the agent layer (the source of the stream). It used to live in the voice
 * channel runtime; it was relocated here so the prose is a `text` block at
 * the source and the channel/voice path consumes typed blocks only.
 *
 * Implementation: a small char-by-char state machine. Tracks string boundaries
 * (with full escape handling including `\uXXXX`), object/array nesting depth,
 * and the most recently seen top-level key. Emits characters only while
 * inside the value of a key matching `targetKey` at depth 1.
 *
 * Why hand-written instead of a SAX library (clarinet/jsonparse): zero deps,
 * runs in browser + Node, ~150 lines.
 *
 * Usage:
 *
 *   const ex = new MessageFieldExtractor('message');
 *   for (const chunk of tokenStream) {
 *     const prose = ex.Feed(chunk);
 *     if (prose.length > 0) emit({ Kind: 'text', Content: prose });
 *   }
 *   // Reset between LLM responses (e.g. between agent steps):
 *   ex.Reset();
 *
 * Limitations (acceptable):
 *   - Strict JSON only — no JSON5, no comments.
 *   - Only the first matching `targetKey` value per envelope is emitted. If
 *     the agent's JSON contains `message` twice at depth 1 (it shouldn't),
 *     only the first is emitted.
 *   - Surrogate-pair `\uXXXX\uYYYY` sequences emit each half independently;
 *     for BMP characters this is fine. Astral-plane glyphs would render
 *     incorrectly — vanishingly rare for prose.
 *   - If the stream contains leading non-JSON (e.g. ```json code fence), it
 *     is skipped — we wait for the first `{`.
 */

export class MessageFieldExtractor {
    constructor(private readonly targetKey: string = 'message') {}

    // ---- streaming state ----
    private mode: 'before-start' | 'json' = 'before-start';
    private depth = 0;
    private inString = false;
    private isKey = false;
    private keyBuffer = '';
    private lastKeyAtDepth1: string | null = null;
    private expectingValue = false;
    private emitting = false;
    private finishedTargetValue = false;
    private escapeState: 'none' | 'after-backslash' | 'unicode' = 'none';
    private unicodeHex = '';

    /**
     * Reset state. Call between LLM responses (e.g. when the prompt step's
     * `stepEntityId` changes for loop-agent multi-step runs). Each agent
     * step's JSON envelope is independent — keys, depth, escape state all
     * start fresh.
     */
    public Reset(): void {
        this.mode = 'before-start';
        this.depth = 0;
        this.inString = false;
        this.isKey = false;
        this.keyBuffer = '';
        this.lastKeyAtDepth1 = null;
        this.expectingValue = false;
        this.emitting = false;
        this.finishedTargetValue = false;
        this.escapeState = 'none';
        this.unicodeHex = '';
    }

    /**
     * Feed a chunk of input. Returns the concatenation of characters from
     * `chunk` that fall inside the target field's value. Returns `''` if
     * the chunk contributed no characters.
     */
    public Feed(chunk: string): string {
        if (this.finishedTargetValue) return '';
        let out = '';
        for (let i = 0; i < chunk.length; i++) {
            out += this.step(chunk[i]!);
        }
        return out;
    }

    /** True once a target-key value has been fully emitted within this envelope. */
    public get IsDone(): boolean {
        return this.finishedTargetValue;
    }

    private step(c: string): string {
        if (this.mode === 'before-start') {
            if (c === '{') {
                this.mode = 'json';
                this.depth = 1;
            }
            return '';
        }

        if (this.inString) {
            return this.stepInString(c);
        }

        // Structural char
        switch (c) {
            case '"':
                this.inString = true;
                if (this.depth === 1) {
                    if (this.expectingValue) {
                        if (
                            this.lastKeyAtDepth1 === this.targetKey &&
                            !this.finishedTargetValue
                        ) {
                            this.emitting = true;
                        }
                        this.expectingValue = false;
                    } else {
                        this.isKey = true;
                        this.keyBuffer = '';
                    }
                }
                return '';
            case '{':
            case '[':
                this.depth++;
                this.expectingValue = false;
                return '';
            case '}':
            case ']':
                this.depth--;
                this.expectingValue = false;
                return '';
            case ':':
                if (this.depth === 1) this.expectingValue = true;
                return '';
            case ',':
                if (this.depth === 1) {
                    this.expectingValue = false;
                }
                return '';
            default:
                return ''; // whitespace and any other non-structural chars
        }
    }

    private stepInString(c: string): string {
        if (this.escapeState === 'after-backslash') {
            this.escapeState = 'none';
            if (c === 'u') {
                this.escapeState = 'unicode';
                this.unicodeHex = '';
                return '';
            }
            const translated = this.translateEscape(c);
            return this.deliverChar(translated);
        }
        if (this.escapeState === 'unicode') {
            this.unicodeHex += c;
            if (this.unicodeHex.length === 4) {
                this.escapeState = 'none';
                const code = parseInt(this.unicodeHex, 16);
                this.unicodeHex = '';
                if (Number.isNaN(code)) return '';
                return this.deliverChar(String.fromCharCode(code));
            }
            return '';
        }
        if (c === '\\') {
            this.escapeState = 'after-backslash';
            return '';
        }
        if (c === '"') {
            this.inString = false;
            if (this.isKey) {
                this.lastKeyAtDepth1 = this.keyBuffer;
                this.keyBuffer = '';
                this.isKey = false;
            }
            if (this.emitting) {
                this.emitting = false;
                this.finishedTargetValue = true;
            }
            return '';
        }
        return this.deliverChar(c);
    }

    private deliverChar(c: string): string {
        if (this.isKey) {
            this.keyBuffer += c;
            return '';
        }
        if (this.emitting) {
            return c;
        }
        return '';
    }

    private translateEscape(c: string): string {
        switch (c) {
            case 'n': return '\n';
            case 't': return '\t';
            case 'r': return '\r';
            case 'b': return '\b';
            case 'f': return '\f';
            case '"': return '"';
            case '\\': return '\\';
            case '/': return '/';
            default: return c;
        }
    }
}
