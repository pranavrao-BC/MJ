/**
 * Unit tests for Loop Agent inter-turn streaming messages.
 *
 * The Loop agent emits one clean user-facing progress string per turn via the
 * `streamingMessage` field on its structured response. When an `onStreaming`
 * callback is wired at runtime, BaseAgent forwards that string over the existing
 * streaming rail; otherwise nothing is emitted and the field is never even
 * declared in the system prompt.
 *
 * BaseAgent has heavy runtime dependencies, so — following the established
 * pattern in this test suite (see resolve-templates.test.ts,
 * agent-type-prompt-params.test.ts) — we mirror the two small, pure pieces of
 * logic that live in BaseAgent:
 *   1. `streamingEnabled = !!params.onStreaming` (the prompt-param signal)
 *   2. the per-turn emit decision + guard around the callback
 * and assert the actual prompt template contains the conditional gate.
 *
 * @since 2.131.0
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ============================================================================
// Test helpers — standalone mirrors of the BaseAgent logic under test.
// These avoid instantiating BaseAgent with all its dependencies.
// ============================================================================

/** Minimal shape of the streaming chunk the callback receives. */
interface StreamChunk {
    content: string;
    isComplete: boolean;
    stepType: string;
    stepEntityId: string;
    block: { Kind: string; Content: string };
}

/**
 * Mirrors the `streamingEnabled` assignment in BaseAgent.preparePromptParams:
 *   agentTypePromptParams.streamingEnabled = !!params.onStreaming;
 */
function computeStreamingEnabled(onStreaming: ((chunk: StreamChunk) => void) | undefined): boolean {
    return !!onStreaming;
}

/**
 * Mirrors the inter-turn emit block in BaseAgent's prompt-step handling.
 * Forwards `streamingMessage` over `onStreaming` exactly once per turn when both
 * the callback and a non-empty string message are present. A throwing callback
 * must never propagate (the agent loop continues).
 */
function emitStreamingMessage(
    onStreaming: ((chunk: StreamChunk) => void) | undefined,
    promptResult: { result?: { streamingMessage?: unknown } },
    stepEntityId: string,
    logError: (err: Error) => void
): void {
    if (!onStreaming) {
        return;
    }
    const streamingMessage = promptResult.result?.streamingMessage;
    if (typeof streamingMessage === 'string' && streamingMessage.length > 0) {
        try {
            onStreaming({
                content: streamingMessage,
                isComplete: true,
                stepType: 'prompt',
                stepEntityId,
                block: { Kind: 'text', Content: streamingMessage }
            });
        } catch (err) {
            logError(err as Error);
        }
    }
}

// ============================================================================
// streamingEnabled signal
// ============================================================================

describe('LoopAgent streaming — streamingEnabled signal', () => {
    it('is true when an onStreaming callback is supplied', () => {
        expect(computeStreamingEnabled(() => {})).toBe(true);
    });

    it('is false when no onStreaming callback is supplied', () => {
        expect(computeStreamingEnabled(undefined)).toBe(false);
    });
});

// ============================================================================
// Per-turn emit behavior
// ============================================================================

describe('LoopAgent streaming — per-turn emit', () => {
    const stepEntityId = 'STEP-123';

    it('fires the callback exactly once per turn with the parsed message and isComplete:true', () => {
        const onStreaming = vi.fn<[StreamChunk], void>();
        const logError = vi.fn();

        emitStreamingMessage(
            onStreaming,
            { result: { streamingMessage: 'Searching the knowledge base...' } },
            stepEntityId,
            logError
        );

        expect(onStreaming).toHaveBeenCalledTimes(1);
        const chunk = onStreaming.mock.calls[0][0];
        expect(chunk.content).toBe('Searching the knowledge base...');
        expect(chunk.isComplete).toBe(true);
        expect(chunk.stepType).toBe('prompt');
        expect(chunk.stepEntityId).toBe(stepEntityId);
        expect(chunk.block).toEqual({ Kind: 'text', Content: 'Searching the knowledge base...' });
        expect(logError).not.toHaveBeenCalled();
    });

    it('does not fire when onStreaming is set but streamingMessage is absent', () => {
        const onStreaming = vi.fn<[StreamChunk], void>();
        emitStreamingMessage(onStreaming, { result: { message: 'hi' } as Record<string, unknown> }, stepEntityId, vi.fn());
        expect(onStreaming).not.toHaveBeenCalled();
    });

    it('does not fire when streamingMessage is an empty string', () => {
        const onStreaming = vi.fn<[StreamChunk], void>();
        emitStreamingMessage(onStreaming, { result: { streamingMessage: '' } }, stepEntityId, vi.fn());
        expect(onStreaming).not.toHaveBeenCalled();
    });

    it('does not fire when streamingMessage is present but is not a string', () => {
        const onStreaming = vi.fn<[StreamChunk], void>();
        emitStreamingMessage(onStreaming, { result: { streamingMessage: 42 } }, stepEntityId, vi.fn());
        expect(onStreaming).not.toHaveBeenCalled();
    });

    it('does nothing when onStreaming is undefined even if streamingMessage is present', () => {
        const logError = vi.fn();
        // Must not throw and must not attempt any callback.
        expect(() =>
            emitStreamingMessage(undefined, { result: { streamingMessage: 'ignored' } }, stepEntityId, logError)
        ).not.toThrow();
        expect(logError).not.toHaveBeenCalled();
    });

    it('swallows a throwing callback so the agent loop continues', () => {
        const boom = new Error('callback exploded');
        const onStreaming = vi.fn<[StreamChunk], void>(() => {
            throw boom;
        });
        const logError = vi.fn();

        expect(() =>
            emitStreamingMessage(
                onStreaming,
                { result: { streamingMessage: 'Drafting your reply...' } },
                stepEntityId,
                logError
            )
        ).not.toThrow();

        expect(onStreaming).toHaveBeenCalledTimes(1);
        expect(logError).toHaveBeenCalledTimes(1);
        expect(logError).toHaveBeenCalledWith(boom);
    });
});

// ============================================================================
// Prompt template gate
// ============================================================================

describe('LoopAgent streaming — prompt template gate', () => {
    const templatePath = resolve(
        __dirname,
        '../../../../../metadata/prompts/templates/system/loop-agent-type-system-prompt.template.md'
    );
    const template = readFileSync(templatePath, 'utf-8');

    it('declares streamingMessage only inside a streamingEnabled Liquid gate', () => {
        // The field declaration must exist...
        expect(template).toContain('streamingMessage: string;');
        // ...wrapped in the conditional gate.
        const gated = /\{%\s*if\s+__agentTypePromptParams\.streamingEnabled\s*%\}[\s\S]*?streamingMessage:\s*string;[\s\S]*?\{%\s*endif\s*%\}/;
        expect(gated.test(template)).toBe(true);
    });

    it('includes a behavioral instruction gated on streamingEnabled', () => {
        const note = /\{%\s*if\s+__agentTypePromptParams\.streamingEnabled\s*%\}[\s\S]*?`streamingMessage`/;
        expect(note.test(template)).toBe(true);
    });
});
