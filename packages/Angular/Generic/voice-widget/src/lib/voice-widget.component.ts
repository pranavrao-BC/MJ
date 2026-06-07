import {
    AfterViewChecked,
    ChangeDetectorRef,
    Component,
    ElementRef,
    EventEmitter,
    Input,
    OnDestroy,
    OnInit,
    Output,
    ViewChild,
    ViewEncapsulation,
    inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MJButtonDirective } from '@memberjunction/ng-ui-components';
import { AgentClientService } from '@memberjunction/ng-agent-client';
import { GraphQLDataProvider } from '@memberjunction/graphql-dataprovider';
import { Subscription } from 'rxjs';

import { VoiceWidgetService } from './voice-widget.service';
import {
    WhiteboardChannelComponent,
    WhiteboardDrawOp,
    LoadWhiteboardChannel,
} from './whiteboard-channel/whiteboard-channel.component';
import {
    RunTimelineComponent,
    LoadRunTimeline,
} from './run-timeline/run-timeline.component';
import {
    RunActor,
    RunBlock,
    VoiceActionableCommand,
    VoiceAudioFrame,
    VoiceChannelName,
    VoiceTranscriptEntry,
    VoiceTranscriptEvent,
    VoiceWidgetStatus,
} from './voice-widget.types';

// Keep the whiteboard child in the bundle — it's only resolved via the
// template, which ESBuild can't see through for dead-code elimination.
LoadWhiteboardChannel();
// Same for the run-timeline child — template-only resolution, so anchor it.
LoadRunTimeline();

/** Which secondary side panel (if any) is open. At most one at a time. */
export type VoiceSecondaryPanel = 'none' | 'activity' | 'whiteboard';

// ---------------------------------------------------------------------------
// Minimal SpeechRecognition type shim.
//
// The Web Speech API is not part of TypeScript's default DOM lib at TS 5.x.
// We declare just enough of the surface we touch to stay `any`-free.
// ---------------------------------------------------------------------------
interface SpeechRecognitionAlternativeLike {
    transcript: string;
}
interface SpeechRecognitionResultLike {
    isFinal: boolean;
    0: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
    resultIndex: number;
    results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionErrorEventLike {
    error: string;
}
interface SpeechRecognitionLike {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    onstart: (() => void) | null;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
interface WindowWithSpeechRecognition extends Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
}

/**
 * `<mj-voice-widget>` — provider-agnostic UI for talking to an MJ AI Agent
 * over the text-in / voice-out channel path. The user types OR speaks (via
 * the browser's Web Speech API), the agent's reply streams back as PCM audio.
 *
 * Wire shape (in/out):
 *   Inputs:
 *     - `AgentID`        — UUID of the MJ AI Agent to drive.
 *     - `ChannelName`    — `'voice-cascaded'` (default) or `'voice-realtime'`.
 *                          For the text-in/voice-out demo, `'voice-cascaded'`
 *                          + no `RoomName` is the canonical pair.
 *     - `AutoStart`      — kick off `Start()` on `ngOnInit` (rare; usually the
 *                          user clicks Start so the AudioContext can resume
 *                          under a gesture).
 *   Outputs:
 *     - `SessionStarted` / `SessionEnded` / `ErrorOccurred`.
 *
 * Generic-package constraints (see `packages/Angular/Generic/CLAUDE.md`):
 *   - No `Router` / `ActivatedRoute` imports.
 *   - Audio playback lives in this component so callers don't need to wire it.
 *   - Standalone, `@if`/`@for` syntax, `inject()` DI, design tokens.
 *
 * Microphone (Web Speech API):
 *   - Chrome / Edge expose `window.webkitSpeechRecognition` (Google STT under
 *     the hood, free, no signup). Firefox/Safari do not — we surface a
 *     "requires Chrome or Edge" warning when `MicSupported` is false.
 *   - Final transcripts are submitted via the same `SubmitChannelTextTurn`
 *     mutation as typed input — the server can't tell the difference.
 *   - The mic auto-pauses while the agent is speaking (echo + self-transcribe
 *     prevention) and auto-resumes when playback drains, but only if the user
 *     had it on (`wantsMicOn`).
 */
@Component({
    selector: 'mj-voice-widget',
    standalone: true,
    imports: [CommonModule, FormsModule, MJButtonDirective, WhiteboardChannelComponent, RunTimelineComponent],
    templateUrl: './voice-widget.component.html',
    styleUrls: ['./voice-widget.component.scss'],
    encapsulation: ViewEncapsulation.Emulated,
})
export class VoiceWidgetComponent implements OnInit, OnDestroy, AfterViewChecked {
    /** Scroll container — auto-scrolled to bottom on new messages. */
    @ViewChild('transcriptEl', { static: false })
    private transcriptEl?: ElementRef<HTMLElement>;
    /**
     * The whiteboard child. Present only while the whiteboard panel is the
     * active secondary panel (it's mounted/unmounted with the panel). A setter
     * is used so that the moment it mounts we flush any draw-ops that arrived
     * before it existed — see `pendingDrawOps`. Always guard with optional
     * chaining before calling its methods.
     */
    private _whiteboard?: WhiteboardChannelComponent;
    @ViewChild('whiteboard')
    private set whiteboard(value: WhiteboardChannelComponent | undefined) {
        this._whiteboard = value;
        if (value) {
            this.flushPendingDrawOps();
        }
    }
    private get whiteboard(): WhiteboardChannelComponent | undefined {
        return this._whiteboard;
    }

    /**
     * Draw-ops that arrived before the whiteboard component was mounted. The
     * agent can emit a `draw-op` at any time, but the whiteboard panel/child
     * only exists while that panel is open. We buffer here, auto-open the
     * panel, and flush on mount (or immediately if already present). Cleared
     * once applied so an op is never drawn twice.
     */
    private pendingDrawOps: WhiteboardDrawOp[] = [];
    /** Track length of last-rendered transcript to detect new entries cheaply. */
    private lastRenderedTranscriptLength = 0;
    /** UUID of the agent to talk to. Required. */
    @Input() public AgentID!: string;

    /** Channel name registered in `MJ: AI Agent Channels`. Defaults to the demo path. */
    @Input() public ChannelName: VoiceChannelName = 'voice-cascaded';

    /**
     * Optional Conversation ID — pin this voice session to an existing chat.
     * Per-turn ConversationDetail rows get written to it so the conversation
     * keeps continuity across voice + text surfaces.
     *
     * If omitted, the server auto-creates a fresh conversation for the voice
     * session (named "Voice with <agent>"). Safe to leave undefined for
     * standalone voice; pass in a Conversation.ID to join an open chat tab.
     */
    @Input() public ConversationID: string | null = null;

    /**
     * If true, attempt to start the session in `ngOnInit`. Mostly useful in
     * tests — for real users, clicking Start lets the browser unlock the
     * AudioContext under a user gesture (autoplay policy).
     */
    @Input() public AutoStart = false;

    @Output() public readonly SessionStarted = new EventEmitter<{ SessionID: string }>();
    @Output() public readonly SessionEnded = new EventEmitter<{ SessionID: string; Reason?: string }>();
    @Output() public readonly ErrorOccurred = new EventEmitter<{ Error: string }>();
    /**
     * Emitted when the user clicks an actionable-command chip. Host apps
     * (e.g. Explorer) decide how to execute — typically a route/navigation,
     * a record open, or running an action. The widget itself is generic and
     * doesn't know what the commands mean.
     */
    @Output() public readonly ActionableCommandClicked = new EventEmitter<VoiceActionableCommand>();

    public Status: VoiceWidgetStatus = 'idle';
    public Transcript: VoiceTranscriptEntry[] = [];
    public CurrentInput = '';
    public AudioChunkCount = 0;
    public SessionID: string | null = null;
    public LastError: string | null = null;
    /**
     * Latest actionable commands from the most recent `agent-response`
     * transcript event. Cleared when the user submits a new turn (so chips
     * don't outlive their context).
     */
    public ActionableCommands: VoiceActionableCommand[] = [];
    /**
     * True while a user turn is in flight (between submit and agent-response /
     * error). Drives the typing-dots indicator at the bottom of the transcript.
     */
    public IsAgentThinking = false;

    // -- Microphone state ------------------------------------------------------
    /** True while the underlying SpeechRecognition is actively listening. */
    public IsMicEnabled = false;
    /** Partial transcript shown to the user as they speak. */
    public InterimTranscript = '';
    /** False on browsers without Web Speech API (Firefox, Safari w/o flag). */
    public MicSupported = false;
    /** Last error from the recognizer, displayed in the status area. */
    public MicError: string | null = null;
    /** True while the agent's audio is playing back — mic auto-pauses. */
    public AgentSpeaking = false;

    // -- Layout / panels -------------------------------------------------------
    /**
     * Whether voice (mic + audio) is available. Drives the mic button's
     * presence. Defaults on; a host can disable it for text-only deployments.
     */
    @Input() public ShowVoiceChannel = true;

    /**
     * Whether the whiteboard feature is wired up. The Explorer host flips this
     * on for the tutoring demo via `[ShowWhiteboardChannel]`. When true, the
     * Whiteboard toggle appears in the toolbar and the secondary panel opens
     * to the whiteboard on first start.
     */
    private _showWhiteboardChannel = false;
    @Input()
    public set ShowWhiteboardChannel(value: boolean) {
        const previous = this._showWhiteboardChannel;
        this._showWhiteboardChannel = value;
        // Host turned the whiteboard on (e.g. tutoring demo) — open it.
        if (value && !previous) {
            this.SecondaryPanel = 'whiteboard';
        }
        // Host turned it off while it was showing — fall back to no panel.
        if (!value && this.SecondaryPanel === 'whiteboard') {
            this.SecondaryPanel = 'none';
        }
    }
    public get ShowWhiteboardChannel(): boolean {
        return this._showWhiteboardChannel;
    }

    /**
     * Which secondary side panel is open. At most one shows at a time so the
     * conversation stays the calm primary column. The whiteboard channel must
     * stay mounted while it's the active panel; Activity (the run timeline) is
     * a lightweight presentational view fed by `RunActors`.
     */
    public SecondaryPanel: VoiceSecondaryPanel = 'none';

    /** Display name of the driving agent — shown in the header + run timeline. */
    @Input() public AgentDisplayName = 'Agent';

    /**
     * Live run model — the block + actor view. The root agent (`Id:'root'`)
     * plus one sub-agent per delegation (keyed by `CallID`), each owning the
     * ordered blocks flowing in (consumed) / out (emitted). Fed DOWN into
     * `<mj-run-timeline>` as an `@Input()` — no `@ViewChild`, no imperative
     * feed, no race. This is the data-down fix.
     */
    public RunActors: RunActor[] = [];

    /** Root-actor id constant — the driving agent. */
    private static readonly ROOT_ACTOR_ID = 'root';

    /**
     * Timestamp of the last `draw` block pushed to the root actor. Used to
     * dedupe a rapid flurry of draw-ops into roughly one block per second so
     * the run view doesn't get spammed during a multi-stroke drawing.
     */
    private lastDrawBlockAt = 0;

    /**
     * True while the root actor has an in-progress `out` text block that should
     * be updated in place (rather than appended) as more text arrives. Reset on
     * each new user turn and when a response finalizes.
     */
    private rootTextBlockActive = false;

    private readonly voiceService = inject(VoiceWidgetService);
    private readonly cdr = inject(ChangeDetectorRef);
    /**
     * Shared MJ client-tool dispatcher. Reused as-is from Skip / Explorer
     * chat — the voice channel is just another transport on top of the same
     * SessionID-keyed PubSub topic. The consuming app (Explorer) registers
     * the actual tool handlers (navigateToRecord, showResource, etc.); we
     * just attach a session ID so the subscription starts and stops with
     * the voice call.
     */
    private readonly agentClient = inject(AgentClientService);

    private audioSubscription: Subscription | null = null;
    private transcriptSubscription: Subscription | null = null;
    /** Bound `beforeunload`/`pagehide` listener — removed in ngOnDestroy. */
    private beforeUnloadHandler: (() => void) | null = null;
    /**
     * Buffer of streamed assistant-text chunks for the in-progress turn.
     * Reset on each user submission. Appended to the transcript on
     * agent-response finalization.
     */
    private assistantBuffer = '';
    /**
     * Accumulates finalized speech fragments across short pauses. We submit the
     * whole utterance only after the user goes quiet for `turnSilenceMs`, so a
     * mid-thought pause no longer fires a turn (which made the agent jump in
     * and talk over the user).
     */
    private pendingUtterance = '';
    /** Fires the debounced turn submission once the user stops speaking. */
    private silenceTimer: ReturnType<typeof setTimeout> | null = null;
    /** Pause length that counts as "done speaking" → submit the turn. */
    private readonly turnSilenceMs = 1400;
    /**
     * Debounce timer for whiteboard snapshot upload. Each completed student
     * stroke pushes the deadline out; once the student pauses drawing we
     * capture one PNG snapshot and send it up to the agent.
     */
    private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
    /** Quiet period after the last stroke before we upload a snapshot. */
    private readonly snapshotDebounceMs = 1200;
    private audioCtx: AudioContext | null = null;
    /** Next scheduled start time for the audio graph — drives gapless playback. */
    private nextStartTime = 0;
    /**
     * Tracks whether we've seen an audio chunk since the last user turn.
     * Used to add a single "agent speaking" entry per agent reply rather than
     * one per PCM frame.
     */
    private agentTurnInProgress = false;

    // -- Microphone internals --------------------------------------------------
    private recognition: SpeechRecognitionLike | null = null;
    /**
     * User-toggled intent. Distinct from `IsMicEnabled` (the actual recognizer
     * state). We honor `wantsMicOn` when deciding whether to auto-restart in
     * `onend` or after the agent finishes speaking.
     */
    private wantsMicOn = false;
    /** Snapshot taken when agent starts speaking so we can restore mic state after. */
    private wasMicEnabledBeforeAgentSpoke = false;
    /**
     * Polling interval that checks whether the agent's scheduled audio has
     * drained. Cheaper than wiring `source.onended` on every PCM frame —
     * playback is gapless, so only the *final* drain matters and we can detect
     * it by comparing `audioCtx.currentTime` to `nextStartTime`.
     */
    private agentSpeakingTimer: ReturnType<typeof setInterval> | null = null;

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    public async ngOnInit(): Promise<void> {
        this.initializeMic();
        // beforeunload — ensure orphaned `Running` AgentRun rows finalize on
        // tab close. Angular's ngOnDestroy doesn't reliably fire when the
        // browser is closed; `navigator.sendBeacon` is the standard escape
        // hatch. It POSTs synchronously inside the unload handler.
        this.beforeUnloadHandler = () => this.sendEndBeacon();
        window.addEventListener('beforeunload', this.beforeUnloadHandler);
        window.addEventListener('pagehide', this.beforeUnloadHandler);
        if (this.AutoStart && this.AgentID) {
            await this.Start();
        }
    }

    /**
     * Auto-scroll the transcript to bottom when new entries arrive. We track
     * length rather than diff content because the upsert-in-place flow
     * mutates the last entry; we want a scroll on both new entries AND
     * in-place streaming appends (so users see the message growing).
     */
    public ngAfterViewChecked(): void {
        const el = this.transcriptEl?.nativeElement;
        if (!el) return;
        // Heuristic: if the user is near the bottom already, follow.
        const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        if (isNearBottom || this.Transcript.length !== this.lastRenderedTranscriptLength) {
            el.scrollTop = el.scrollHeight;
        }
        this.lastRenderedTranscriptLength = this.Transcript.length;
    }

    public async ngOnDestroy(): Promise<void> {
        this.stopAgentSpeakingTimer();
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
        }
        if (this.snapshotTimer) {
            clearTimeout(this.snapshotTimer);
            this.snapshotTimer = null;
        }
        if (this.beforeUnloadHandler) {
            window.removeEventListener('beforeunload', this.beforeUnloadHandler);
            window.removeEventListener('pagehide', this.beforeUnloadHandler);
            this.beforeUnloadHandler = null;
        }
        if (this.recognition) {
            this.wantsMicOn = false;
            try { this.recognition.abort(); } catch { /* ignore — abort on a non-started recognizer throws */ }
            this.recognition = null;
        }
        await this.teardown('cancelled');
    }

    /**
     * Fire-and-forget end-of-session signal on tab close. Uses
     * `navigator.sendBeacon` because regular fetch() inside `beforeunload`
     * is unreliable — browsers cancel pending requests. The beacon survives
     * tab close.
     *
     * Reads the GraphQL URL from the active `GraphQLDataProvider` so we
     * hit the same endpoint the rest of the app uses. If the provider
     * isn't configured (shouldn't happen — the widget is started after
     * Explorer boots), we silently skip; the server-side run timeout is
     * the backstop in that case.
     */
    private sendEndBeacon(): void {
        if (!this.SessionID) return;
        try {
            const url = GraphQLDataProvider.Instance.ConfigData?.URL;
            if (!url) return;
            const body = JSON.stringify({
                query: `mutation E($input: EndChannelSessionInput!) {
                    EndChannelSession(input: $input) { OK }
                }`,
                variables: {
                    input: { SessionID: this.SessionID, Reason: 'user-disconnect' },
                },
            });
            navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        } catch {
            // best-effort — nothing more we can do during unload
        }
    }

    // ---------------------------------------------------------------------
    // Public API (template-bound + programmatic)
    // ---------------------------------------------------------------------

    /**
     * Start the session. **Must be called from a user gesture** the first time
     * so the browser allows `AudioContext.resume()`. Subsequent restarts after
     * `End()` work fine since the context is already running.
     */
    public async Start(): Promise<void> {
        if (this.Status === 'connecting' || this.Status === 'active') {
            return;
        }
        if (!this.AgentID) {
            this.failWith('AgentID is required before starting a voice session.');
            return;
        }
        this.Status = 'connecting';
        this.LastError = null;

        try {
            await this.ensureAudioContext();

            const result = await this.voiceService.StartSession(
                this.AgentID,
                this.ChannelName,
                this.ConversationID
            );
            this.SessionID = result.SessionID;

            // Start the shared MJ client-tool subscription keyed on this
            // session's ID. Server-side `ClientToolRequestManager.RequestClientTool`
            // publishes with this exact SessionID, so the listener picks up
            // tool calls emitted by any of the agent's prompt steps.
            this.agentClient.StartSession(result.SessionID);

            this.audioSubscription = this.voiceService.SubscribeToAudio(result.SessionID).subscribe({
                next: (frame) => this.onAudioFrame(frame),
                error: (err) => this.failWith(this.formatError(err)),
                complete: () => {
                    // Stream completed naturally — usually means the session ended
                    // on the server side. Mark ourselves ended unless we already are.
                    if (this.Status === 'active') {
                        this.Status = 'ended';
                        this.cdr.markForCheck();
                    }
                },
            });

            // Transcript events arrive on a sibling subscription and drive
            // the running transcript pane + actionable-command chips. An
            // error here is non-fatal — audio still works without transcripts.
            this.transcriptSubscription = this.voiceService
                .SubscribeToTranscript(result.SessionID)
                .subscribe({
                    next: (event) => this.onTranscriptEvent(event),
                    error: (err) =>
                        console.warn('[VoiceWidget] transcript subscription error:', err),
                });

            this.Status = 'active';
            this.SessionStarted.emit({ SessionID: result.SessionID });
            this.cdr.markForCheck();
        } catch (err) {
            this.failWith(this.formatError(err));
        }
    }

    /**
     * Submit the current text input as a user turn. Auto-starts the session if
     * one isn't active yet (matches the voice-demo.html UX — typing implies
     * "go").
     */
    public async Send(): Promise<void> {
        const text = this.CurrentInput.trim();
        if (!text) return;
        this.CurrentInput = '';
        await this.submitUserText(text);
    }

    /**
     * End the session cleanly. Idempotent.
     */
    public async End(): Promise<void> {
        const sessionId = this.SessionID;
        // Stop the mic when the session ends — there's nothing to send to.
        if (this.recognition) {
            this.wantsMicOn = false;
            try { this.recognition.stop(); } catch { /* ignore */ }
        }
        await this.teardown('user-disconnect');
        if (sessionId) {
            this.SessionEnded.emit({ SessionID: sessionId, Reason: 'user-disconnect' });
        }
    }

    /** Handle Enter in the text input (Shift+Enter for newline). */
    public OnInputKeydown(event: KeyboardEvent): void {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void this.Send();
        }
    }

    /**
     * Grow / shrink the composer textarea to fit content. Matches the
     * "type as much as you want" UX of modern chat composers. Bounded by
     * the SCSS `max-height: 200px` rule, after which the textarea scrolls.
     */
    public OnInputAutoResize(event: Event): void {
        const el = event.target as HTMLTextAreaElement | null;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    }

    // ---------------------------------------------------------------------
    // Public API — channel toggles + whiteboard
    // ---------------------------------------------------------------------

    /**
     * Toggle a secondary side panel. Opening one closes the other (only one
     * secondary panel is visible at a time); clicking the open one closes it,
     * returning to the calm conversation-only layout.
     */
    public ToggleSecondaryPanel(panel: 'activity' | 'whiteboard'): void {
        // Opening the whiteboard implies the channel must be wired up.
        if (panel === 'whiteboard') {
            this._showWhiteboardChannel = true;
        }
        this.SecondaryPanel = this.SecondaryPanel === panel ? 'none' : panel;
        this.cdr.markForCheck();
    }

    /**
     * The student finished a freehand stroke. Debounce ~1.2s (so a flurry of
     * strokes coalesces into one upload), then snapshot the canvas and send it
     * up to the agent. Guarded on an active session — no point uploading before
     * the agent is listening.
     */
    public OnUserStroke(_op: WhiteboardDrawOp): void {
        if (this.Status !== 'active' || !this.SessionID) {
            return;
        }
        if (this.snapshotTimer) {
            clearTimeout(this.snapshotTimer);
        }
        this.snapshotTimer = setTimeout(() => {
            this.snapshotTimer = null;
            void this.uploadCanvasSnapshot();
        }, this.snapshotDebounceMs);
    }

    /** Capture the current whiteboard as a PNG and push it to the agent. */
    private async uploadCanvasSnapshot(): Promise<void> {
        const sessionId = this.SessionID;
        const board = this.whiteboard;
        if (this.Status !== 'active' || !sessionId || !board) {
            return;
        }
        try {
            const base64 = board.CaptureSnapshotBase64();
            if (!base64) {
                return;
            }
            const result = await this.voiceService.SubmitCanvasSnapshot(sessionId, base64, 'image/png');
            if (!result.OK) {
                console.warn(
                    '[VoiceWidget] SubmitCanvasSnapshot returned OK=false:',
                    result.ErrorMessage
                );
            }
        } catch (err) {
            console.warn('[VoiceWidget] canvas snapshot upload failed:', this.formatError(err));
        }
    }

    // ---------------------------------------------------------------------
    // Public API — microphone
    // ---------------------------------------------------------------------

    /** Toggle the microphone on or off (template-bound). */
    public ToggleMic(): void {
        if (this.IsMicEnabled || this.wantsMicOn) {
            this.StopMic();
        } else {
            void this.StartMic();
        }
    }

    /**
     * Turn on the mic. The click handler call is what unlocks the AudioContext
     * in Safari/Chrome's autoplay policy (mic gesture also doubles as audio
     * unlock — we resume the context here too).
     */
    public async StartMic(): Promise<void> {
        if (!this.MicSupported || !this.recognition) return;
        await this.ensureAudioContext();
        this.wantsMicOn = true;
        this.MicError = null;
        try {
            this.recognition.start();
        } catch (err) {
            // "InvalidStateError: recognition has already started" is benign —
            // we tolerate it. Anything else gets surfaced.
            const msg = this.formatError(err);
            if (!/already started|InvalidStateError/i.test(msg)) {
                this.MicError = msg;
            }
        }
        this.cdr.markForCheck();
    }

    /** Turn off the mic. */
    public StopMic(): void {
        this.wantsMicOn = false;
        if (this.recognition) {
            try { this.recognition.stop(); } catch { /* ignore — stopping a non-started recognizer throws */ }
        }
        this.cdr.markForCheck();
    }

    // ---------------------------------------------------------------------
    // Internals — microphone (Web Speech API)
    // ---------------------------------------------------------------------

    private initializeMic(): void {
        const w = window as WindowWithSpeechRecognition;
        const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
        if (!Ctor) {
            this.MicSupported = false;
            return;
        }
        this.MicSupported = true;
        this.recognition = new Ctor();
        this.recognition.lang = 'en-US';
        this.recognition.continuous = false;     // one utterance per turn; we restart for each
        this.recognition.interimResults = true;  // show transcription as user speaks
        this.recognition.maxAlternatives = 1;

        this.recognition.onstart = () => {
            this.IsMicEnabled = true;
            this.MicError = null;
            this.InterimTranscript = '';
            this.cdr.markForCheck();
        };

        this.recognition.onresult = (event) => {
            let interim = '';
            let final = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                if (result.isFinal) {
                    final += result[0].transcript;
                } else {
                    interim += result[0].transcript;
                }
            }
            const trimmed = final.trim();
            if (trimmed) {
                this.pendingUtterance = this.pendingUtterance
                    ? `${this.pendingUtterance} ${trimmed}`
                    : trimmed;
            }
            // Live feedback: accumulated-so-far plus the current interim words.
            this.InterimTranscript = [this.pendingUtterance, interim].filter(Boolean).join(' ');
            // Debounce: only submit after the user pauses (turn boundary), so
            // pausing mid-thought doesn't trigger the agent.
            if (this.pendingUtterance) {
                this.armSilenceFlush();
            }
            this.cdr.markForCheck();
        };

        this.recognition.onerror = (event) => {
            // 'no-speech' and 'aborted' are routine — don't surface as errors.
            if (event.error === 'no-speech' || event.error === 'aborted') {
                return;
            }
            this.MicError = event.error || 'mic error';
            this.IsMicEnabled = false;
            this.cdr.markForCheck();
        };

        this.recognition.onend = () => {
            this.IsMicEnabled = false;
            this.InterimTranscript = '';
            this.cdr.markForCheck();
            // Auto-restart if the user still wants the mic on and the agent
            // isn't currently speaking. Continuous-listening UX — one utterance
            // ends, immediately listen for the next.
            if (this.wantsMicOn && !this.AgentSpeaking && this.SessionID && this.recognition) {
                setTimeout(() => {
                    if (this.wantsMicOn && !this.AgentSpeaking && this.recognition) {
                        try { this.recognition.start(); } catch { /* benign races */ }
                    }
                }, 100);
            }
        };
    }

    /**
     * (Re)start the silence timer. Each new finalized fragment pushes the
     * deadline out; when the user finally pauses for `turnSilenceMs`, the
     * accumulated utterance is submitted as one turn.
     */
    private armSilenceFlush(): void {
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
        }
        this.silenceTimer = setTimeout(() => {
            this.silenceTimer = null;
            const utterance = this.pendingUtterance.trim();
            this.pendingUtterance = '';
            this.InterimTranscript = '';
            if (utterance) {
                void this.submitUserText(utterance);
            }
            this.cdr.markForCheck();
        }, this.turnSilenceMs);
    }

    /**
     * Shared path for both the Send button and the mic's final-transcript
     * handler. Auto-starts the session, appends the user turn to the transcript,
     * and submits via GraphQL.
     */
    private async submitUserText(text: string): Promise<void> {
        if (this.Status !== 'active' || !this.SessionID) {
            // Auto-start (typing/talking is a user gesture, so AudioContext.resume() will succeed).
            await this.Start();
            if (!this.SessionID) return; // Start failed; error already surfaced.
        }

        // Clear the chips and assistant buffer for the new turn — chips are
        // tied to the most recent agent response, not historic.
        this.ActionableCommands = [];
        this.assistantBuffer = '';
        // Note: we deliberately do NOT appendTranscript('user', text) here.
        // The server now publishes a `user` transcript event for every turn
        // (including text-input), and the widget renders that. Appending
        // locally as well would produce a double entry.
        this.agentTurnInProgress = false;

        try {
            const submitResult = await this.voiceService.SubmitTextTurn(this.SessionID!, text);
            if (!submitResult.OK) {
                const msg = submitResult.ErrorMessage ?? 'SubmitChannelTextTurn returned OK=false';
                this.appendTranscript('system', msg);
                this.LastError = msg;
                this.cdr.markForCheck();
            }
        } catch (err) {
            this.failWith(this.formatError(err));
        }
    }

    // ---------------------------------------------------------------------
    // Internals — audio playback
    // ---------------------------------------------------------------------

    /**
     * Create the AudioContext on first use (lazily) and resume it. This MUST
     * be called from a user gesture handler the first time, hence the call
     * site in `Start()` / `Send()` / `StartMic()` (all initiated by clicks/keystrokes).
     */
    private async ensureAudioContext(): Promise<void> {
        if (!this.audioCtx) {
            this.audioCtx = new AudioContext();
        }
        if (this.audioCtx.state === 'suspended') {
            await this.audioCtx.resume();
        }
    }

    /**
     * Decode one PCM frame and schedule it for gapless playback. Algorithm
     * mirrors `voice-demo.html`'s `playPCMFrame`:
     *
     *   1. base64 → bytes → Int16Array
     *   2. Int16 → Float32 (normalize by 32768)
     *   3. Demux channels if `ChannelCount > 1`
     *   4. Schedule at `max(currentTime, nextStartTime)` and advance the cursor
     *
     * Non-PCM media types fall through with a console warning — supporting
     * compressed formats (mp3/opus) would mean `audioCtx.decodeAudioData`,
     * which is async-per-frame and would break the gapless scheduling. The
     * server currently only emits `audio/pcm` for ElevenLabs cascaded TTS, so
     * this is fine for the demo.
     */
    /**
     * Render a transcript event from the server. User finals append a new
     * row. Assistant-text deltas append into the in-progress assistant row
     * (created on the first delta of each turn). The terminal `agent-response`
     * event populates the chip row and flushes the assembled text in case
     * the streaming path was empty.
     */
    private onTranscriptEvent(event: VoiceTranscriptEvent): void {
        // Every session that produces events has a root agent actor.
        this.ensureRootActor();
        switch (event.Kind) {
            case 'user':
                if (event.Text) {
                    this.appendTranscript('user', event.Text);
                    // New user turn — reset the assistant accumulator so the
                    // next reply starts a fresh bubble.
                    this.assistantBuffer = '';
                    // A user turn just started — agent will now think.
                    this.IsAgentThinking = true;
                    // Root consumes a `user` block; the next reply starts fresh
                    // accumulated text, so reset the live-text tracker.
                    this.pushRootBlock({ Direction: 'in', Kind: 'user', Summary: event.Text });
                    this.rootTextBlockActive = false;
                }
                break;
            case 'assistant-text':
                // Realtime S2S models (Gemini Live / GPT Realtime) stream their
                // output transcription here — that IS the spoken answer, so we
                // render it live (type-in-place). For the cascaded loop-agent
                // path we still suppress it: multi-step agents emit a `message`
                // per step and the canonical text arrives via `agent-response`.
                if (this.ChannelName === 'voice-realtime' && event.Text) {
                    this.IsAgentThinking = false;
                    this.assistantBuffer += event.Text;
                    this.upsertAssistantTranscript(this.assistantBuffer);
                    // Mirror into the run model: a single `out` text block that
                    // grows in place as deltas arrive.
                    this.upsertRootTextBlock(this.assistantBuffer);
                }
                break;
            case 'agent-response':
                this.IsAgentThinking = false;
                if (event.Text) {
                    this.appendTranscript('agent', event.Text);
                    // Finalize the root text block with the canonical message.
                    this.upsertRootTextBlock(event.Text);
                }
                // The text block is now final — the next turn starts a new one.
                this.rootTextBlockActive = false;
                if (event.ActionableCommands && event.ActionableCommands.length > 0) {
                    this.ActionableCommands = event.ActionableCommands;
                }
                this.assistantBuffer = '';
                break;
            case 'tool-call':
                this.upsertToolBlock(event);
                break;
            case 'draw-op':
                // Agent drew on the shared whiteboard. The runtime/server and
                // client draw-op shapes are structurally identical but declared
                // in separate files, so cast across the cross-declared union.
                if (event.DrawOp) {
                    this.routeDrawOp(event.DrawOp as unknown as WhiteboardDrawOp);
                    // Mirror into the run model: an `out` draw block (deduped).
                    this.pushRootDrawBlock();
                }
                break;
            case 'error':
                this.IsAgentThinking = false;
                if (event.Text) {
                    this.appendTranscript('system', `Error: ${event.Text}`);
                }
                break;
        }
        this.cdr.markForCheck();
    }

    // ---------------------------------------------------------------------
    // Internals — whiteboard draw-op routing
    // ---------------------------------------------------------------------

    /**
     * Route an agent draw-op to the whiteboard. The whiteboard child only
     * exists while its panel is open, so:
     *   1. Auto-open the whiteboard panel (the agent is drawing — show it).
     *   2. If the child is mounted, apply immediately.
     *   3. Otherwise buffer the op; it flushes when the child mounts (via the
     *      `whiteboard` ViewChild setter) and again on the next microtask in
     *      case the panel was opened synchronously this tick.
     */
    private routeDrawOp(op: WhiteboardDrawOp): void {
        this._showWhiteboardChannel = true;
        if (this.SecondaryPanel !== 'whiteboard') {
            this.SecondaryPanel = 'whiteboard';
        }
        if (this.whiteboard) {
            this.whiteboard.ApplyDrawOp(op);
            return;
        }
        // Not mounted yet — buffer and flush once the view materializes. The
        // microtask covers the case where we just opened the panel this tick.
        this.pendingDrawOps.push(op);
        Promise.resolve().then(() => this.flushPendingDrawOps());
    }

    /** Apply and clear any buffered draw-ops once the whiteboard is present. */
    private flushPendingDrawOps(): void {
        const board = this.whiteboard;
        if (!board || this.pendingDrawOps.length === 0) {
            return;
        }
        const ops = this.pendingDrawOps;
        this.pendingDrawOps = [];
        for (const op of ops) {
            board.ApplyDrawOp(op);
        }
    }

    /**
     * Replace-in-place if the last entry is the in-progress agent row,
     * otherwise append a new agent row. This is what gives the running
     * "type-in-place" effect as the message-field tokens stream.
     */
    private upsertAssistantTranscript(text: string): void {
        const last = this.Transcript[this.Transcript.length - 1];
        if (last && last.Role === 'agent') {
            // Replace the last entry — Angular sees a new array via slice
            // because the entry object is the same reference but the parent
            // array gets a fresh shell.
            const next = this.Transcript.slice(0, -1);
            next.push({ Role: 'agent', Text: text, Timestamp: last.Timestamp });
            this.Transcript = next;
        } else {
            this.Transcript = [
                ...this.Transcript,
                { Role: 'agent', Text: text, Timestamp: new Date() },
            ];
        }
    }

    /** Handle a chip click; emit upward to the host app. */
    public OnActionableCommandClick(cmd: VoiceActionableCommand): void {
        this.ActionableCommandClicked.emit(cmd);
    }

    private onAudioFrame(frame: VoiceAudioFrame): void {
        if (frame.MediaType !== 'audio/pcm') {
            console.warn(
                `[VoiceWidget] Unsupported media type '${frame.MediaType}' — only audio/pcm is rendered by the gapless scheduler. Frame dropped.`
            );
            return;
        }
        if (!this.audioCtx) {
            // Should not happen — ensureAudioContext() runs before Subscribe.
            return;
        }

        this.AudioChunkCount += 1;
        // Note: we no longer append a '🔊 speaking…' placeholder here. The
        // transcript subscription now delivers the actual assistant text in
        // real time via `onTranscriptEvent`, which is far better UX. We still
        // track `agentTurnInProgress` so other code (e.g. mic-suppression
        // heuristics) can read it.
        this.agentTurnInProgress = true;
        // Mirror into the run model: one accumulating `out` audio block on the
        // root actor (frame count climbs; we never push a block per frame).
        this.ensureRootActor();
        this.upsertRootAudioBlock(this.AudioChunkCount);

        const audioBuffer = this.decodePCMFrame(frame, this.audioCtx);
        const source = this.audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.audioCtx.destination);
        const startAt = Math.max(this.audioCtx.currentTime, this.nextStartTime);
        source.start(startAt);
        this.nextStartTime = startAt + audioBuffer.duration;

        // Mark the agent as speaking so the mic auto-pauses. If this is the
        // first frame of the turn, snapshot the user's mic intent so we can
        // restore it later, then stop the recognizer.
        if (!this.AgentSpeaking) {
            this.wasMicEnabledBeforeAgentSpoke = this.wantsMicOn;
            if (this.IsMicEnabled || this.wantsMicOn) {
                // Suppress auto-restart in `onend` while the agent is talking.
                this.wantsMicOn = false;
                if (this.recognition) {
                    try { this.recognition.stop(); } catch { /* ignore */ }
                }
            }
            this.AgentSpeaking = true;
            this.startAgentSpeakingTimer();
            this.cdr.markForCheck();
        }
    }

    /**
     * "Agent finished speaking" detection.
     *
     * Mechanism: poll every 100ms — when `audioCtx.currentTime >= nextStartTime`
     * the gapless playback queue has drained. We chose polling over
     * `source.onended` because playback is gapless (many sources chained head
     * to tail); attaching onended to every frame would mean firing the
     * transition handler dozens of times per turn and threading state about
     * "which source was the last one." A single 100ms timer is simpler and
     * the latency on resuming the mic is imperceptible.
     */
    private startAgentSpeakingTimer(): void {
        this.stopAgentSpeakingTimer();
        this.agentSpeakingTimer = setInterval(() => {
            if (!this.audioCtx) return;
            if (this.audioCtx.currentTime >= this.nextStartTime - 0.01) {
                this.stopAgentSpeakingTimer();
                this.AgentSpeaking = false;
                // Restore mic if the user had it on before the agent started speaking.
                if (this.wasMicEnabledBeforeAgentSpoke && this.SessionID && this.recognition) {
                    this.wantsMicOn = true;
                    try { this.recognition.start(); } catch { /* recognizer may already be re-armed */ }
                }
                this.wasMicEnabledBeforeAgentSpoke = false;
                this.cdr.markForCheck();
            }
        }, 100);
    }

    private stopAgentSpeakingTimer(): void {
        if (this.agentSpeakingTimer) {
            clearInterval(this.agentSpeakingTimer);
            this.agentSpeakingTimer = null;
        }
    }

    /**
     * Pure decode: base64 PCM → AudioBuffer. Extracted so it's easy to unit
     * test (no AudioContext side effects beyond `createBuffer`).
     */
    private decodePCMFrame(frame: VoiceAudioFrame, ctx: AudioContext): AudioBuffer {
        const bytes = this.base64ToBytes(frame.DataBase64);
        const int16 = new Int16Array(
            bytes.buffer,
            bytes.byteOffset,
            Math.floor(bytes.byteLength / 2)
        );
        const totalFloat = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
            totalFloat[i] = int16[i] / 32768;
        }
        const framesPerChannel = totalFloat.length / frame.ChannelCount;
        const audioBuffer = ctx.createBuffer(frame.ChannelCount, framesPerChannel, frame.SampleRateHz);
        if (frame.ChannelCount === 1) {
            audioBuffer.copyToChannel(totalFloat, 0);
        } else {
            for (let ch = 0; ch < frame.ChannelCount; ch++) {
                const channelData = new Float32Array(framesPerChannel);
                for (let i = 0; i < framesPerChannel; i++) {
                    channelData[i] = totalFloat[i * frame.ChannelCount + ch];
                }
                audioBuffer.copyToChannel(channelData, ch);
            }
        }
        return audioBuffer;
    }

    private base64ToBytes(base64: string): Uint8Array {
        const binary = atob(base64);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            out[i] = binary.charCodeAt(i);
        }
        return out;
    }

    // ---------------------------------------------------------------------
    // Internals — teardown + error handling
    // ---------------------------------------------------------------------

    private async teardown(reason: string): Promise<void> {
        this.stopAgentSpeakingTimer();
        if (this.audioSubscription) {
            this.audioSubscription.unsubscribe();
            this.audioSubscription = null;
        }
        if (this.transcriptSubscription) {
            this.transcriptSubscription.unsubscribe();
            this.transcriptSubscription = null;
        }
        // Stop the client-tool subscription before clearing SessionID so the
        // unsubscribe still has the active session in hand.
        try {
            this.agentClient.StopSession();
        } catch {
            // Best-effort — AgentClientService.StopSession is no-op if no session.
        }
        const sessionId = this.SessionID;
        this.SessionID = null;

        if (sessionId) {
            try {
                await this.voiceService.EndSession(sessionId, reason);
            } catch (err) {
                // Swallow — teardown is best-effort, the session expires on the
                // server eventually. Log so dev can see it in the console.
                console.warn('[VoiceWidget] EndSession threw during teardown:', err);
            }
        }

        // We intentionally do NOT close the AudioContext here — keeping it
        // alive across End/Start cycles avoids needing a second user gesture.
        this.nextStartTime = 0;
        this.AudioChunkCount = 0;
        this.agentTurnInProgress = false;
        this.AgentSpeaking = false;
        // Clear the run model — it belongs to the session that just ended.
        this.RunActors = [];
        this.pendingDrawOps = [];
        this.lastDrawBlockAt = 0;
        this.rootTextBlockActive = false;
        if (this.Status !== 'error') {
            this.Status = 'ended';
        }
        this.cdr.markForCheck();
    }

    private failWith(message: string): void {
        this.LastError = message;
        this.Status = 'error';
        this.appendTranscript('system', message);
        this.ErrorOccurred.emit({ Error: message });
        this.cdr.markForCheck();
    }

    private appendTranscript(role: 'user' | 'agent' | 'system', text: string): void {
        this.Transcript = [...this.Transcript, { Role: role, Text: text, Timestamp: new Date() }];
    }

    /**
     * Render a tool-call BLOCK. Upserts by `CallID` so the same block updates
     * in place across its running → complete/error lifecycle (the visible
     * "Delegating to Code Smith… → done" progress).
     */
    private upsertToolBlock(event: VoiceTranscriptEvent): void {
        const status = (event.Status as 'running' | 'complete' | 'error') ?? 'running';
        const headline = event.Label ?? event.ToolName ?? 'Working…';
        const text = event.Detail ? `${headline}\n${event.Detail}` : headline;
        const existing = event.CallID
            ? this.Transcript.find((e) => e.Role === 'tool' && e.CallID === event.CallID)
            : undefined;
        if (existing) {
            existing.Text = text;
            existing.Status = status;
            this.Transcript = this.Transcript.slice();
        } else {
            this.Transcript = [
                ...this.Transcript,
                { Role: 'tool', Text: text, Timestamp: new Date(), CallID: event.CallID, Status: status },
            ];
        }
        // Mirror the block into the live block + actor run model.
        this.applyToolCallToRunModel(event, status);
        // A tool block means the agent is actively doing work, not idle-thinking.
        this.IsAgentThinking = false;
        this.cdr.markForCheck();
    }

    // ---------------------------------------------------------------------
    // Internals — block + actor run model
    // ---------------------------------------------------------------------

    /** Ensure the root agent actor exists. Created lazily on the first event. */
    private ensureRootActor(): void {
        if (this.RunActors.some((a) => a.Id === VoiceWidgetComponent.ROOT_ACTOR_ID)) {
            return;
        }
        const root: RunActor = {
            Id: VoiceWidgetComponent.ROOT_ACTOR_ID,
            Label: this.AgentDisplayName,
            Kind: 'agent',
            Status: 'active',
            Blocks: [],
            StartedAt: Date.now(),
        };
        // Root always leads the list so sub-agents render nested beneath it.
        this.RunActors = [root, ...this.RunActors];
    }

    /** Locate the mutable root actor (created by `ensureRootActor`). */
    private rootActor(): RunActor | undefined {
        return this.RunActors.find((a) => a.Id === VoiceWidgetComponent.ROOT_ACTOR_ID);
    }

    /** Append a block to the root actor and trigger a re-render. */
    private pushRootBlock(block: RunBlock): void {
        const root = this.rootActor();
        if (!root) {
            return;
        }
        root.Blocks = [...root.Blocks, block];
        this.RunActors = this.RunActors.slice();
    }

    /**
     * Upsert the root actor's in-progress `out` text block. While
     * `rootTextBlockActive`, update the last text block in place as deltas
     * arrive; otherwise start a new one. This is the run-model mirror of the
     * transcript's type-in-place behavior.
     */
    private upsertRootTextBlock(text: string): void {
        const root = this.rootActor();
        if (!root) {
            return;
        }
        const summary = text.trim();
        if (!summary) {
            return;
        }
        const last = root.Blocks[root.Blocks.length - 1];
        if (this.rootTextBlockActive && last && last.Direction === 'out' && last.Kind === 'text') {
            last.Summary = summary;
        } else {
            root.Blocks = [...root.Blocks, { Direction: 'out', Kind: 'text', Summary: summary }];
            this.rootTextBlockActive = true;
        }
        this.RunActors = this.RunActors.slice();
    }

    /**
     * Push an `out` draw block onto the root actor, deduped to roughly one per
     * second so a rapid drawing flurry doesn't flood the run view.
     */
    private pushRootDrawBlock(): void {
        const now = Date.now();
        if (now - this.lastDrawBlockAt < 1000) {
            return;
        }
        this.lastDrawBlockAt = now;
        this.pushRootBlock({ Direction: 'out', Kind: 'draw', Summary: 'drew on whiteboard' });
    }

    /**
     * Upsert a single `out` audio block on the root actor, accumulating the
     * frame count rather than pushing a block per PCM frame.
     */
    private upsertRootAudioBlock(frameCount: number): void {
        const root = this.rootActor();
        if (!root) {
            return;
        }
        const summary = `speaking · ${frameCount} frame${frameCount === 1 ? '' : 's'}`;
        const existing = root.Blocks.find((b) => b.Direction === 'out' && b.Kind === 'audio');
        if (existing) {
            existing.Summary = summary;
        } else {
            root.Blocks = [...root.Blocks, { Direction: 'out', Kind: 'audio', Summary: summary }];
        }
        this.RunActors = this.RunActors.slice();
    }

    /**
     * Apply a delegation `tool-call` block to the run model. Two effects:
     *   1. The ROOT actor emits an `out` `tool-call` block ("delegate → X")
     *      once, on the `running` event.
     *   2. A SUB-AGENT actor (keyed by `CallID`) is upserted: on `running` it
     *      starts (consuming an `in` `user` task block); on `complete` it
     *      finishes (emitting an `out` `tool-result` block) with a duration; on
     *      `error` it goes to error status.
     */
    private applyToolCallToRunModel(
        event: VoiceTranscriptEvent,
        status: 'running' | 'complete' | 'error',
    ): void {
        const callId = event.CallID;
        if (!callId) {
            return;
        }
        const target = this.deriveRunEntryName(event) || 'Sub-agent';
        const existing = this.RunActors.find((a) => a.Id === callId);

        if (status === 'running') {
            if (!existing) {
                // Root emits its delegation block (once).
                this.pushRootBlock({ Direction: 'out', Kind: 'tool-call', Summary: `delegate → ${target}` });
                const sub: RunActor = {
                    Id: callId,
                    Label: target,
                    Kind: 'sub-agent',
                    Status: 'running',
                    StartedAt: Date.now(),
                    Blocks: event.Detail
                        ? [{ Direction: 'in', Kind: 'user', Summary: event.Detail }]
                        : [],
                };
                this.RunActors = [...this.RunActors, sub];
            } else {
                existing.Status = 'running';
                existing.Label = target || existing.Label;
                this.RunActors = this.RunActors.slice();
            }
            return;
        }

        // complete / error — finalize the sub-agent.
        if (!existing) {
            return;
        }
        existing.Status = status;
        existing.Label = target || existing.Label;
        existing.DurationMs = Date.now() - (existing.StartedAt ?? Date.now());
        if (status === 'complete' && event.Detail) {
            existing.Blocks = [
                ...existing.Blocks,
                { Direction: 'out', Kind: 'tool-result', Summary: event.Detail },
            ];
        }
        this.RunActors = this.RunActors.slice();
    }

    /**
     * Derive the delegated target's display name from the block.
     *
     * There is no server-side provenance field naming the target sub-agent, so
     * we parse the human `Label` the loop agent emits:
     *   "Delegating to Code Smith…"  → "Code Smith"
     *   "Code Smith done (15.0s)"     → "Code Smith"
     *   "Code Smith failed: <reason>" → "Code Smith"
     * Falling back to `ToolName`. Presentation heuristic only.
     */
    private deriveRunEntryName(event: VoiceTranscriptEvent): string {
        const parsed = this.parseTargetFromLabel(event.Label);
        if (parsed) {
            return parsed;
        }
        return event.ToolName?.trim() || '';
    }

    /** Pull the target name out of a free-form progress label. */
    private parseTargetFromLabel(label: string | undefined): string | null {
        if (!label) {
            return null;
        }
        const trimmed = label.trim();
        // "Delegating to <Name>…" — take everything after the "to ".
        const delegateMatch = /(?:delegating|handing off|calling)\s+to\s+(.+)$/i.exec(trimmed);
        if (delegateMatch) {
            return this.stripTrailingNoise(delegateMatch[1]);
        }
        // "<Name> done (…)" / "<Name> failed: …" / "<Name> complete" — take the
        // leading clause up to the status verb.
        const statusMatch = /^(.+?)\s+(?:done|complete|completed|finished|failed|error)\b/i.exec(trimmed);
        if (statusMatch) {
            return this.stripTrailingNoise(statusMatch[1]);
        }
        return this.stripTrailingNoise(trimmed) || null;
    }

    /** Trim trailing ellipsis / punctuation / whitespace from a parsed name. */
    private stripTrailingNoise(value: string): string {
        return value.replace(/[….\s:,-]+$/u, '').trim();
    }

    private formatError(err: unknown): string {
        if (err instanceof Error) return err.message;
        if (typeof err === 'string') return err;
        try {
            return JSON.stringify(err);
        } catch {
            return String(err);
        }
    }

    // ---------------------------------------------------------------------
    // Template helpers
    // ---------------------------------------------------------------------

    public get StatusLabel(): string {
        switch (this.Status) {
            case 'idle':
                return 'Idle';
            case 'connecting':
                return 'Connecting…';
            case 'active':
                return 'Active';
            case 'error':
                return 'Error';
            case 'ended':
                return 'Ended';
            default:
                return this.Status;
        }
    }

    public TrackByIndex(index: number): number {
        return index;
    }
}

/**
 * Tree-shake-prevention symbol. Imported once from MJExplorer's
 * `voice-demo-resource.component.ts` so the bundler keeps this class in the
 * final bundle even though it's only resolved dynamically via `@RegisterClass`
 * (well — the wrapper resource is the registered class; this widget is a
 * direct dependency of that wrapper). Mirrors the pattern in other Generic
 * packages.
 */
export function LoadVoiceWidget(): void {
    // Intentional no-op.
}
