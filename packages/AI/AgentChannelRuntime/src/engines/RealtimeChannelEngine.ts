/**
 * `RealtimeChannelEngine` — thin shim that runs a voice channel's bidirectional
 * speech-to-speech (S2S) session AS a native MemberJunction agent run.
 *
 * The brain lives in the framework: `RealtimeAgentType` (in `@memberjunction/ai-agents`)
 * owns the model session, tool routing (delegate + whiteboard draw), and lifecycle.
 * This engine REUSES the channel's existing transport + widget + subscriptions
 * unchanged and is now responsible only for:
 *   - adapting `ctx.Transport` (channel `AudioFrame` / `ControlEvent`) to the
 *     framework's `RealtimeAgentTransport` seam (base64 `RealtimeAudioFrame` /
 *     `RealtimeControlEvent`),
 *   - deriving an `AbortSignal` cancellation token from `ctx.Interrupt`,
 *   - bridging the run's native `AgentStreamBlock` stream back onto `ctx.OnTranscript`
 *     so the existing widget renders text / tool-call / draw activity, and
 *   - calling `AgentRunner.RunAgent({ ..., realtimeTransport, agentTypeParams })`.
 *
 * The session's audio flows entirely through the transport adapter — the widget's
 * `ChannelAudioOut` subscription plays it exactly as before. No STT/LLM/TTS pipeline,
 * no VAD, no turn detector: the realtime model does its own endpointing server-side.
 *
 * IMPORTANT — agent-type selection: `RunAgent` picks the agent-type brain from the
 * agent's `TypeID` (→ AIAgentType.DriverClass). There is NO per-run agent-type
 * override on `ExecuteAgentParams` / `RunAgent`. For this engine to drive
 * `RealtimeAgentType`, the channel's agent MUST be of a Realtime-typed AIAgentType
 * (DriverClass `'RealtimeAgentType'`). That metadata is created out-of-band (see the
 * project report); this shim works as soon as it exists.
 */
import { LogError, LogStatus, RunView } from '@memberjunction/core';
import { RegisterClass } from '@memberjunction/global';
import { AgentRunner, DRAW_APPEND_MARKER, type RealtimeAgentExecuteParams } from '@memberjunction/ai-agents';
import type {
    ExecuteAgentParams,
    MJAIAgentEntityExtended,
    AgentStreamBlock,
    RealtimeAgentTransport,
    RealtimeAudioFrame,
    RealtimeControlEvent,
} from '@memberjunction/ai-core-plus';
import type { AudioFrame } from '@memberjunction/ai';
import { randomUUID } from 'crypto';
import { BaseChannelEngine, ChannelRunContext, ChannelStopReason } from '../BaseChannelEngine';
import { VoiceRealtimeConfig } from '../types/channel-config';
import type { ControlEvent } from '../frames/frame-bus';

@RegisterClass(BaseChannelEngine, 'RealtimeChannelEngine')
export class RealtimeChannelEngine extends BaseChannelEngine {
    private stopped = false;
    /** Aborts the underlying agent run on Stop()/barge-in. */
    private abort = new AbortController();
    private disposeInterrupt: (() => void) | null = null;

    public async Run(ctx: ChannelRunContext): Promise<void> {
        const cfg = narrowVoiceRealtimeConfig(ctx);
        const agent = await this.resolveExtendedAgent(ctx);

        // Bridge ctx.Interrupt → the run's cancellation token. A barge-in or
        // manual interrupt aborts the run, which RealtimeAgentType maps onto
        // session cancel + close.
        this.disposeInterrupt = ctx.Interrupt.On(() => this.abort.abort());

        const realtimeTransport = buildRealtimeTransport(ctx);
        const agentTypeParams: RealtimeAgentExecuteParams = {
            realtimeModelId: cfg.Realtime.AIModelID,
            instructions: cfg.Instructions,
            // The draw tool is built into RealtimeAgentType; no extraTools needed here.
            extraTools: [],
        };

        LogStatus(
            `[ChannelSession ${ctx.SessionID}] realtime-agent-run agent='${agent.Name}' model='${cfg.Realtime.AIModelID}'`
        );

        const params: ExecuteAgentParams = {
            agent,
            conversationMessages: [],
            contextUser: ctx.ContextUser,
            realtimeTransport,
            agentTypeParams,
            cancellationToken: this.abort.signal,
            onStreaming: (chunk) => this.bridgeBlock(ctx, chunk.block),
        };

        try {
            const result = await new AgentRunner().RunAgent(params);
            if (result.success !== true) {
                const msg = result.agentRun?.ErrorMessage ?? 'realtime agent run failed';
                LogError(`[ChannelSession ${ctx.SessionID}] realtime-agent-run failed: ${msg}`);
                ctx.OnTranscript?.({ Kind: 'error', Message: msg });
            }
        } catch (err) {
            LogError(`[ChannelSession ${ctx.SessionID}] realtime-agent-run threw: ${errMsg(err)}`);
            ctx.OnTranscript?.({ Kind: 'error', Message: errMsg(err) });
        } finally {
            this.stopped = true;
            this.disposeInterrupt?.();
            this.disposeInterrupt = null;
        }
        LogStatus(`[ChannelSession ${ctx.SessionID}] realtime-session-closed`);
    }

    public async Stop(_reason: ChannelStopReason): Promise<void> {
        this.stopped = true;
        this.abort.abort();
        this.disposeInterrupt?.();
        this.disposeInterrupt = null;
    }

    /**
     * Bridge a native `AgentStreamBlock` from the agent run onto a channel
     * transcript event so the existing widget renders it:
     *   - `text`      → `assistant-text`
     *   - `tool-call` → `tool-call` (running/complete/error lifecycle)
     *   - `html`      → `draw-op` (Type:'svg', full-canvas) — the whiteboard path,
     *                   with an optional leading `clear` op (suppressed when the
     *                   markup carries the append marker).
     * `thinking` / `tool-result` are skipped on the voice path (the model speaks).
     */
    private bridgeBlock(ctx: ChannelRunContext, block: AgentStreamBlock | undefined): void {
        if (!block) {
            return;
        }
        switch (block.Kind) {
            case 'text':
                ctx.OnTranscript?.({ Kind: 'assistant-text', Text: block.Content, IsFinal: false });
                break;
            case 'tool-call':
                ctx.OnTranscript?.({
                    Kind: 'tool-call',
                    CallID: block.CallID,
                    ToolName: block.Name,
                    Label: block.Label ?? block.Name,
                    Status: block.Status,
                    Detail: block.Detail,
                });
                break;
            case 'html':
                this.bridgeDrawBlock(ctx, block.Html);
                break;
            default:
                // thinking / tool-result — not surfaced on the voice path.
                break;
        }
    }

    /**
     * Turn an agent-drawn `html` block (SVG markup) into draw-op(s) on the shared
     * whiteboard. The default is replace-the-board (a `clear` op then the `svg`
     * op); a leading {@link DRAW_APPEND_MARKER} requests append (no clear).
     */
    private bridgeDrawBlock(ctx: ChannelRunContext, html: string): void {
        const append = html.startsWith(DRAW_APPEND_MARKER);
        const markup = append ? html.slice(DRAW_APPEND_MARKER.length) : html;
        if (markup.trim().length === 0) {
            return;
        }
        if (!append) {
            ctx.OnTranscript?.({ Kind: 'draw-op', OpID: randomUUID(), Source: 'agent', Op: { Type: 'clear' } });
        }
        ctx.OnTranscript?.({
            Kind: 'draw-op',
            OpID: randomUUID(),
            Source: 'agent',
            Op: { Type: 'svg', Markup: markup, X: 0, Y: 0, W: 1, H: 1 },
        });
    }

    /**
     * Resolve the channel's agent as a `MJAIAgentEntityExtended` (what `RunAgent`
     * requires). `ctx.AgentMetadata` is the base `MJAIAgentEntity`; load the
     * extended row by ID so we run the channel's EXISTING agent unchanged.
     */
    private async resolveExtendedAgent(ctx: ChannelRunContext): Promise<MJAIAgentEntityExtended> {
        const rv = new RunView();
        const found = await rv.RunView<MJAIAgentEntityExtended>(
            {
                EntityName: 'MJ: AI Agents',
                ExtraFilter: `ID='${ctx.AgentMetadata.ID}'`,
                ResultType: 'entity_object',
            },
            ctx.ContextUser
        );
        const agent = found.Success ? found.Results?.[0] : undefined;
        if (!agent) {
            throw new Error(
                `RealtimeChannelEngine: could not load AI Agent ID='${ctx.AgentMetadata.ID}' for the realtime run.`
            );
        }
        return agent;
    }
}

/**
 * Build the `RealtimeAgentTransport` seam adapter over the channel transport.
 * Maps the channel `AudioFrame` (Uint8Array) ↔ the seam's base64
 * `RealtimeAudioFrame`, and the channel `ControlEvent` → the seam's
 * `RealtimeControlEvent` (including `session-end`).
 */
function buildRealtimeTransport(ctx: ChannelRunContext): RealtimeAgentTransport {
    return {
        AudioFramesIn: mapAudioFramesIn(ctx.Transport.AudioFramesIn),
        SendAudioFrame: (frame: RealtimeAudioFrame): void => {
            ctx.Transport.SendAudioFrame(toChannelAudioFrame(frame));
        },
        ControlEventsIn: mapControlEventsIn(ctx),
    };
}

/** Map inbound channel audio (Uint8Array) → base64 seam frames. */
async function* mapAudioFramesIn(
    src: AsyncIterable<AudioFrame>
): AsyncIterable<RealtimeAudioFrame> {
    for await (const frame of src) {
        yield {
            Data: Buffer.from(frame.data).toString('base64'),
            SampleRateHz: frame.sampleRateHz,
            ChannelCount: frame.channelCount,
            MediaType: frame.mediaType,
        };
    }
}

/** Decode a base64 seam frame → a channel `AudioFrame` (Uint8Array). */
function toChannelAudioFrame(frame: RealtimeAudioFrame): AudioFrame {
    return {
        data: new Uint8Array(Buffer.from(frame.Data, 'base64')),
        sampleRateHz: frame.SampleRateHz,
        channelCount: frame.ChannelCount,
        mediaType: frame.MediaType ?? 'audio/pcm',
    };
}

/**
 * Map inbound channel control events → seam control events. The seam understands
 * `user-text`, `user-canvas-snapshot`, and `session-end`; other channel control
 * kinds (participant join/leave, session-start) are not meaningful to the
 * realtime session and are dropped.
 */
async function* mapControlEventsIn(
    ctx: ChannelRunContext
): AsyncIterable<RealtimeControlEvent> {
    for await (const ev of ctx.Transport.ControlEventsIn) {
        if (ev.Kind === 'session-end') {
            yield { Kind: 'session-end' };
        } else if (ev.Kind === 'user-text') {
            // Echo the user's turn onto the transcript so the widget shows the
            // message the user sent. The agent run only emits AGENT-side
            // AgentStreamBlocks (there is no 'user' block kind), so the channel
            // surfaces the user turn here — mirrors the original engine.
            ctx.OnTranscript?.({ Kind: 'user', Text: ev.Text, IsFinal: true });
            yield { Kind: 'user-text', Text: ev.Text };
        } else if (ev.Kind === 'user-canvas-snapshot') {
            yield { Kind: 'user-canvas-snapshot', ImageBase64: ev.ImageBase64, MediaType: ev.MediaType };
        }
    }
}

/** Narrow `ChannelRunContext.ChannelConfig` to `VoiceRealtimeConfig`. */
function narrowVoiceRealtimeConfig(ctx: ChannelRunContext): VoiceRealtimeConfig {
    const cfg = ctx.ChannelConfig;
    if (cfg.Kind !== 'voice-realtime') {
        throw new Error(
            `RealtimeChannelEngine requires Kind='voice-realtime'; got Kind='${cfg.Kind}'.`
        );
    }
    return cfg;
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
