/**
 * `RealtimeChannelEngine` — drives a bidirectional speech-to-speech (S2S) model
 * (Gemini Live, GPT Realtime) for a voice channel.
 *
 * Unlike `CascadedChannelEngine` there is no STT → LLM → TTS pipeline, no VAD,
 * and no turn detector: the realtime model ingests audio and emits audio
 * directly, doing its own endpointing/VAD server-side. This engine's job is the
 * bridge:
 *   - inbound transport audio  → `session.SendAudio`
 *   - `session.OnAudio`        → outbound transport frames
 *   - `session.OnTranscript`   → transcript events (widget display)
 *   - `session.OnToolCall`     → (prototype) surfaced/logged; agent routing TBD
 *   - barge-in (`InterruptChannel`) → `session.CancelCurrentResponse`
 *
 * Prototype scope (see `plans/monday-demo-implementation.md`): the system
 * prompt is synthesized from the agent's Name/Description rather than the full
 * resolved loop-agent prompt, and native tool calls are not yet routed through
 * `BaseAgent`. Both are documented follow-ups — the demo target is a live,
 * agent-identified S2S conversation.
 */
import { randomUUID } from 'crypto';
import { LogError, LogStatus, Metadata, RunView, UserInfo } from '@memberjunction/core';
import { MJGlobal, RegisterClass } from '@memberjunction/global';
import { MJAIModelEntity } from '@memberjunction/core-entities';
import {
    GetAIAPIKey,
    BaseRealtimeSpeech,
    type RealtimeSpeechConnectOptions,
    type RealtimeSpeechSession,
    type ToolCall,
    type ToolResult,
    type ToolDefinition,
    type ChatMessage,
} from '@memberjunction/ai';
import { AgentRunner } from '@memberjunction/ai-agents';
import type { ExecuteAgentParams, MJAIAgentEntityExtended } from '@memberjunction/ai-core-plus';
import { BaseChannelEngine, ChannelRunContext, ChannelStopReason } from '../BaseChannelEngine';
import { VoiceRealtimeConfig } from '../types/channel-config';
import type { ControlEvent } from '../frames/frame-bus';
import type { DrawOp } from '../types/transcript-event';
import { InterruptReason } from '../interrupt/InterruptChannel';

/**
 * The tool we expose to the realtime model so it can actually DO things mid-
 * conversation instead of just talking about them. When the model calls this,
 * `RealtimeChannelEngine.delegateToAgent` runs the named MJ agent for real and
 * streams a tool-call block back to the UI. (More tools — `run_action`,
 * `run_query` — slot in the same way.)
 */
const DELEGATE_TOOL: ToolDefinition = {
    Name: 'delegate_to_agent',
    Description:
        'Delegate a task to another specialized MemberJunction agent and get its result back. ' +
        'Use this whenever the user asks for work handled by a specific agent (calculations, code, ' +
        'research, data lookups). Announce briefly that you are bringing that agent in, then call this.',
    ParametersSchema: {
        type: 'object',
        properties: {
            agent_name: {
                type: 'string',
                description: 'Exact name of the MJ agent to delegate to, e.g. "Code Smith".',
            },
            task: {
                type: 'string',
                description: 'The full task or question to hand to that agent, with all needed details.',
            },
        },
        required: ['agent_name', 'task'],
    },
};

/**
 * The tool that lets the realtime model DRAW on the shared whiteboard the
 * student is looking at — the visual counterpart to talking. Each call carries
 * an `ops` array; the engine fans each op out as a `DrawOpBlockEvent` on the
 * transcript path, and the widget renders it onto the canvas live.
 *
 * Coordinates are NORMALIZED 0..1 (origin top-left) so the same op renders
 * correctly at any canvas size. The description is deliberately teaching-
 * oriented so the model uses the whiteboard the way a good tutor would: draw
 * the diagram, label it, then talk about it.
 */
const DRAW_ON_WHITEBOARD_TOOL: ToolDefinition = {
    Name: 'draw_on_whiteboard',
    Description:
        'Draw on the shared whiteboard the student is looking at. Use this whenever a picture ' +
        'helps you teach: diagrams, geometric shapes, labeled examples, worked solutions, or ' +
        'sketches. Prefer drawing AND narrating together (e.g. draw a right triangle, then say ' +
        'what you drew). All coordinates are normalized 0..1 with the origin at the top-left ' +
        'corner: X grows rightward, Y grows downward, so the center of the board is (0.5, 0.5). ' +
        'Sizes/widths/font sizes are in pixels at render time. Send several ops in one call to ' +
        'compose a figure (e.g. a shape plus its labels). Use a "clear" op to wipe the board ' +
        'before starting a fresh diagram.',
    ParametersSchema: {
        type: 'object',
        properties: {
            ops: {
                type: 'array',
                description: 'Ordered list of drawing operations to apply to the whiteboard.',
                items: {
                    type: 'object',
                    properties: {
                        Type: {
                            type: 'string',
                            enum: ['stroke', 'shape', 'text', 'clear'],
                            description:
                                "The kind of op: 'stroke' = freehand path through Points; " +
                                "'shape' = a primitive (line/rect/ellipse/triangle/arrow) in a " +
                                "bounding box; 'text' = a text label; 'clear' = erase the whole board.",
                        },
                        Points: {
                            type: 'array',
                            description:
                                "For Type='stroke': the ordered points of the freehand path, each " +
                                'normalized 0..1.',
                            items: {
                                type: 'object',
                                properties: {
                                    X: { type: 'number', description: 'Horizontal position, 0..1.' },
                                    Y: { type: 'number', description: 'Vertical position, 0..1.' },
                                },
                                required: ['X', 'Y'],
                            },
                        },
                        Shape: {
                            type: 'string',
                            enum: ['line', 'rect', 'ellipse', 'triangle', 'arrow'],
                            description: "For Type='shape': which primitive to draw.",
                        },
                        X: {
                            type: 'number',
                            description:
                                "For Type='shape' or 'text': left/anchor X position, normalized 0..1.",
                        },
                        Y: {
                            type: 'number',
                            description:
                                "For Type='shape' or 'text': top/anchor Y position, normalized 0..1.",
                        },
                        W: {
                            type: 'number',
                            description: "For Type='shape': bounding-box width, normalized 0..1.",
                        },
                        H: {
                            type: 'number',
                            description: "For Type='shape': bounding-box height, normalized 0..1.",
                        },
                        Text: {
                            type: 'string',
                            description: "For Type='text': the label to render.",
                        },
                        Color: {
                            type: 'string',
                            description:
                                'CSS color string (e.g. "#1d4ed8", "red"). Applies to stroke, ' +
                                'shape, and text ops.',
                        },
                        Width: {
                            type: 'number',
                            description:
                                "For Type='stroke' or 'shape': line width in pixels at render time.",
                        },
                        FontSize: {
                            type: 'number',
                            description: "For Type='text': font size in pixels at render time.",
                        },
                    },
                    required: ['Type'],
                },
            },
        },
        required: ['ops'],
    },
};

@RegisterClass(BaseChannelEngine, 'RealtimeChannelEngine')
export class RealtimeChannelEngine extends BaseChannelEngine {
    private stopped = false;
    private session: RealtimeSpeechSession | null = null;
    private disposeInterrupt: (() => void) | null = null;
    private audioFrameCount = 0;

    public async Run(ctx: ChannelRunContext): Promise<void> {
        const cfg = narrowVoiceRealtimeConfig(ctx);
        const { driver, modelApiName } = await this.resolveRealtimeProvider(cfg, ctx.ContextUser);

        const opts = this.buildConnectOptions(ctx, modelApiName);
        LogStatus(
            `[ChannelSession ${ctx.SessionID}] realtime-connect model='${modelApiName ?? '(default)'}'`
        );
        const session = await driver.Connect(opts);
        this.session = session;

        this.wireSession(ctx, session);
        this.disposeInterrupt = ctx.Interrupt.On((reason) => this.onInterrupt(session, reason));

        LogStatus(`[ChannelSession ${ctx.SessionID}] realtime-session-open`);
        // Session lifetime is driven by the CONTROL stream (a `session-end`
        // event, i.e. EndChannelSession / transport close). The audio-in pump
        // runs concurrently in the background — it must NOT end the session,
        // because for the text-in transport `AudioFramesIn` is an empty stream
        // that completes immediately (there's no mic). The control loop also
        // forwards `user-text` turns to the model, so realtime works text-in /
        // voice-out through the same widget as the cascaded path.
        const audioPump = this.pumpAudioIn(ctx, session).catch(() => undefined);
        await this.consumeControlEvents(ctx, session);
        this.stopped = true;
        await audioPump;
        await this.cleanup();
        LogStatus(
            `[ChannelSession ${ctx.SessionID}] realtime-session-closed audioFrames=${this.audioFrameCount}`
        );
    }

    public async Stop(_reason: ChannelStopReason): Promise<void> {
        this.stopped = true;
        await this.cleanup();
    }

    private async cleanup(): Promise<void> {
        this.disposeInterrupt?.();
        this.disposeInterrupt = null;
        const session = this.session;
        this.session = null;
        if (session) {
            try {
                await session.Close();
            } catch (err) {
                LogError(`RealtimeChannelEngine: session close error: ${errMsg(err)}`);
            }
        }
    }

    /** Connect session output back to the transport + transcript sink. */
    private wireSession(ctx: ChannelRunContext, session: RealtimeSpeechSession): void {
        session.OnAudio((frame) => {
            if (!this.stopped) {
                this.audioFrameCount++;
                ctx.Transport.SendAudioFrame(frame);
            }
        });
        session.OnTranscript((text, role, isFinal) => {
            ctx.OnTranscript?.(
                role === 'user'
                    ? { Kind: 'user', Text: text, IsFinal: isFinal }
                    : { Kind: 'assistant-text', Text: text, IsFinal: isFinal }
            );
        });
        session.OnToolCall((call) => this.routeToolCall(ctx, call));
    }

    /**
     * Route a native tool call from the realtime model to real MJ execution,
     * emitting tool-call BLOCKS (running → complete/error) so the work is
     * visible in the transcript while it happens. This is what makes the block
     * stream functional: the model emits a tool call, we run actual MJ work
     * (here: delegate to another agent), stream progress as a block, and hand
     * the real result back to the model so it speaks the truth.
     */
    private async routeToolCall(ctx: ChannelRunContext, call: ToolCall): Promise<ToolResult> {
        LogStatus(
            `[ChannelSession ${ctx.SessionID}] realtime-toolcall name='${call.Name}'`
        );
        if (call.Name === 'delegate_to_agent') {
            return this.delegateToAgent(ctx, call);
        }
        if (call.Name === 'draw_on_whiteboard') {
            return this.drawOnWhiteboard(ctx, call);
        }
        ctx.OnTranscript?.({
            Kind: 'tool-call',
            CallID: call.CallID,
            ToolName: call.Name,
            Label: `Unknown tool: ${call.Name}`,
            Status: 'error',
            Detail: 'No handler registered.',
        });
        return { CallID: call.CallID, Error: `Tool '${call.Name}' is not available.` };
    }

    /**
     * Execute `delegate_to_agent`: load the named MJ agent and run it for real
     * via `AgentRunner`, emitting a running → complete tool-call block and
     * returning the agent's actual answer to the realtime model.
     */
    private async delegateToAgent(ctx: ChannelRunContext, call: ToolCall): Promise<ToolResult> {
        const agentName = String(call.Arguments['agent_name'] ?? '').trim();
        const task = String(call.Arguments['task'] ?? '').trim();
        ctx.OnTranscript?.({
            Kind: 'tool-call',
            CallID: call.CallID,
            ToolName: call.Name,
            Label: `Delegating to ${agentName || 'agent'}…`,
            Status: 'running',
            Detail: task.length > 80 ? task.slice(0, 80) + '…' : task,
        });
        const startedMs = Date.now();
        LogStatus(`[ChannelSession ${ctx.SessionID}] delegate-begin agent='${agentName}'`);
        try {
            // Fuzzy name resolution: the model rarely says the exact registered
            // name ("Code Smith" vs the actual "Codesmith Agent"). Load active
            // agents and match on a normalized (lowercased, alnum-only) form.
            const rv = new RunView();
            const found = await rv.RunView<MJAIAgentEntityExtended>(
                {
                    EntityName: 'MJ: AI Agents',
                    ExtraFilter: `Status='Active'`,
                    ResultType: 'entity_object',
                },
                ctx.ContextUser
            );
            const agents = found.Success ? (found.Results ?? []) : [];
            const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
            const want = norm(agentName);
            const agent =
                agents.find((a) => norm(a.Name) === want) ??
                agents.find((a) => want.length > 0 && (norm(a.Name).includes(want) || want.includes(norm(a.Name))));
            if (!agent) {
                const msg = `Agent '${agentName}' not found (searched ${agents.length} active agents).`;
                LogStatus(`[ChannelSession ${ctx.SessionID}] delegate-no-match want='${agentName}'`);
                ctx.OnTranscript?.({
                    Kind: 'tool-call', CallID: call.CallID, ToolName: call.Name,
                    Label: `${agentName}: not found`, Status: 'error', Detail: msg,
                });
                return { CallID: call.CallID, Error: msg };
            }
            LogStatus(`[ChannelSession ${ctx.SessionID}] delegate-matched resolved='${agent.Name}'`);

            const params: ExecuteAgentParams = {
                agent,
                conversationMessages: [{ role: 'user', content: task }] as ChatMessage[],
                contextUser: ctx.ContextUser,
            };
            const result = await new AgentRunner().RunAgent(params);
            const ok = result.success === true;
            const answer = (result.agentRun?.Message?.trim()) ||
                (ok ? '(the agent returned no message)' : (result.agentRun?.ErrorMessage ?? 'agent failed'));
            const secs = ((Date.now() - startedMs) / 1000).toFixed(1);
            LogStatus(`[ChannelSession ${ctx.SessionID}] delegate-end agent='${agentName}' success=${ok} durationS=${secs}`);

            ctx.OnTranscript?.({
                Kind: 'tool-call', CallID: call.CallID, ToolName: call.Name,
                Label: `${agentName} ${ok ? 'done' : 'failed'} (${secs}s)`,
                Status: ok ? 'complete' : 'error',
                Detail: answer.length > 140 ? answer.slice(0, 140) + '…' : answer,
            });
            return ok
                ? { CallID: call.CallID, Result: answer }
                : { CallID: call.CallID, Error: answer };
        } catch (err) {
            LogError(`[ChannelSession ${ctx.SessionID}] delegate-failed agent='${agentName}': ${errMsg(err)}`);
            ctx.OnTranscript?.({
                Kind: 'tool-call', CallID: call.CallID, ToolName: call.Name,
                Label: `${agentName}: error`, Status: 'error', Detail: errMsg(err),
            });
            return { CallID: call.CallID, Error: errMsg(err) };
        }
    }

    /**
     * Execute `draw_on_whiteboard`: fan the model's `ops` array out as one
     * `DrawOpBlockEvent` per op on the transcript path (the widget renders each
     * onto the shared canvas). Drawing is instant, so unlike `delegate_to_agent`
     * there's no running→complete pair — we emit a single completed `tool-call`
     * block for visibility in the text channel, then return.
     *
     * Defensive throughout: malformed ops are skipped rather than thrown, so a
     * single bad op from the model never aborts the whole figure or the session.
     */
    private drawOnWhiteboard(ctx: ChannelRunContext, call: ToolCall): ToolResult {
        const rawOps = call.Arguments['ops'];
        const ops = Array.isArray(rawOps) ? rawOps : [];
        let count = 0;
        for (const raw of ops) {
            const op = coerceDrawOp(raw);
            if (!op) {
                continue;
            }
            ctx.OnTranscript?.({
                Kind: 'draw-op',
                OpID: randomUUID(),
                Source: 'agent',
                Op: op,
            });
            count++;
        }
        LogStatus(
            `[ChannelSession ${ctx.SessionID}] realtime-draw ops=${ops.length} drawn=${count}`
        );
        ctx.OnTranscript?.({
            Kind: 'tool-call',
            CallID: call.CallID,
            ToolName: call.Name,
            Label: '✏️ Drew on whiteboard',
            Status: 'complete',
            Detail: `${count} shape(s)`,
        });
        return { CallID: call.CallID, Result: `drawn ${count} shape(s)` };
    }

    private onInterrupt(session: RealtimeSpeechSession, _reason: InterruptReason): void {
        session.CancelCurrentResponse();
    }

    /** Forward inbound transport audio to the realtime session until stopped. */
    private async pumpAudioIn(ctx: ChannelRunContext, session: RealtimeSpeechSession): Promise<void> {
        try {
            for await (const frame of ctx.Transport.AudioFramesIn) {
                if (this.stopped) {
                    return;
                }
                session.SendAudio(frame);
            }
        } catch (err) {
            if (!this.stopped) {
                LogError(`RealtimeChannelEngine: audio-in pump failed: ${errMsg(err)}`);
            }
        }
    }

    /**
     * Forward `user-text` turns to the model and end the session on
     * `session-end` (or when the control stream closes).
     */
    private async consumeControlEvents(
        ctx: ChannelRunContext,
        session: RealtimeSpeechSession
    ): Promise<void> {
        try {
            for await (const ev of ctx.Transport.ControlEventsIn) {
                if (this.stopped) {
                    return;
                }
                const control = ev as ControlEvent;
                if (control.Kind === 'session-end') {
                    return;
                }
                if (control.Kind === 'user-text' && control.Text) {
                    LogStatus(
                        `[ChannelSession ${ctx.SessionID}] realtime-send-text len=${control.Text.length}`
                    );
                    ctx.OnTranscript?.({ Kind: 'user', Text: control.Text, IsFinal: true });
                    session.SendText(control.Text);
                }
                if (control.Kind === 'user-canvas-snapshot' && control.ImageBase64) {
                    LogStatus(
                        `[ChannelSession ${ctx.SessionID}] realtime-send-canvas mediaType='${control.MediaType}' b64Len=${control.ImageBase64.length}`
                    );
                    session.SendImage(control.ImageBase64, control.MediaType);
                }
            }
        } catch (err) {
            if (!this.stopped) {
                LogError(`RealtimeChannelEngine: control loop failed: ${errMsg(err)}`);
            }
        }
    }

    private buildConnectOptions(
        ctx: ChannelRunContext,
        modelApiName: string | undefined
    ): RealtimeSpeechConnectOptions {
        const agent = ctx.AgentMetadata;
        const systemPrompt = [
            agent.Name ? `You are ${agent.Name}.` : '',
            agent.Description ?? '',
            'You are speaking with the user by voice. Keep replies concise and conversational; avoid markdown, code blocks, and long lists.',
        ]
            .filter((s) => s.length > 0)
            .join('\n\n');

        return {
            SystemPrompt: systemPrompt,
            ModelAPIName: modelApiName,
            ContextUser: ctx.ContextUser,
            Tools: [DELEGATE_TOOL, DRAW_ON_WHITEBOARD_TOOL],
        };
    }

    /**
     * Resolve the realtime model row, its API key, and instantiate the
     * registered `BaseRealtimeSpeech` driver. Mirrors
     * `CascadedChannelEngine.resolveAudioProvider` (DB load rather than
     * `AIEngine` cache — the channel runtime is provider-pure).
     */
    private async resolveRealtimeProvider(
        cfg: VoiceRealtimeConfig,
        contextUser: UserInfo
    ): Promise<{ driver: BaseRealtimeSpeech; modelApiName: string | undefined }> {
        const md = new Metadata();
        const model = await md.GetEntityObject<MJAIModelEntity>('MJ: AI Models', contextUser);
        const loaded = await model.Load(cfg.Realtime.AIModelID);
        if (!loaded) {
            throw new Error(
                `RealtimeChannelEngine: Realtime AIModel not found for ID='${cfg.Realtime.AIModelID}'.`
            );
        }

        // DriverClass/APIName may live on the AIModel row OR (post multi-vendor
        // refactor) on the highest-priority Inference Provider vendor row.
        // Prefer top-level, fall back to the vendor row so we work with both
        // metadata shapes.
        const { driverClass, apiName } = await this.resolveDriverAndApiName(model, contextUser);
        if (!driverClass) {
            throw new Error(
                `RealtimeChannelEngine: Realtime AIModel '${model.Name}' has no DriverClass ` +
                    `(checked the model row and its AI Model Vendor rows).`
            );
        }
        const apiKey = GetAIAPIKey(driverClass);
        if (!apiKey) {
            throw new Error(
                `RealtimeChannelEngine: no API key for DriverClass='${driverClass}'. ` +
                    `Set env AI_VENDOR_API_KEY__${driverClass} or configure credentials in MJ.`
            );
        }
        LogStatus(
            `[RealtimeChannelEngine] resolved driverClass='${driverClass}' apiName='${apiName ?? '(default)'}' keyLen=${apiKey.length} keyTail='${apiKey.slice(-4)}'`
        );
        const driver = MJGlobal.Instance.ClassFactory.CreateInstance<BaseRealtimeSpeech>(
            BaseRealtimeSpeech,
            driverClass,
            apiKey
        );
        if (!driver) {
            throw new Error(
                `RealtimeChannelEngine: no BaseRealtimeSpeech registered for DriverClass='${driverClass}'.`
            );
        }
        return { driver, modelApiName: apiName };
    }

    /**
     * Resolve the driver class + API model name, preferring the AIModel row's
     * own fields and falling back to its highest-priority vendor row that
     * specifies a DriverClass.
     */
    private async resolveDriverAndApiName(
        model: MJAIModelEntity,
        contextUser: UserInfo
    ): Promise<{ driverClass: string | undefined; apiName: string | undefined }> {
        if (model.DriverClass) {
            return { driverClass: model.DriverClass, apiName: model.APIName ?? undefined };
        }
        const rv = new RunView();
        const result = await rv.RunView<{ DriverClass: string | null; APIName: string | null; Priority: number | null }>(
            {
                EntityName: 'MJ: AI Model Vendors',
                ExtraFilter: `ModelID='${model.ID}' AND DriverClass IS NOT NULL AND Status='Active'`,
                OrderBy: 'Priority DESC',
                Fields: ['DriverClass', 'APIName', 'Priority'],
                ResultType: 'simple',
            },
            contextUser
        );
        const row = result.Success ? result.Results?.[0] : undefined;
        return {
            driverClass: row?.DriverClass ?? undefined,
            apiName: row?.APIName ?? model.APIName ?? undefined,
        };
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

/** A finite number, defaulting to `fallback` for anything else (NaN, strings, undefined). */
function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A non-empty string, or `undefined`. */
function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Defensively coerce one raw op (as the model emitted it) into a typed
 * `DrawOp`, or `null` if it's not salvageable. We're permissive on detail
 * (missing color/width get sensible defaults) but strict on structure: a stroke
 * needs at least one point, a shape needs a valid `Shape`, text needs `Text`.
 */
function coerceDrawOp(raw: unknown): DrawOp | null {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const op = raw as Record<string, unknown>;
    switch (op['Type']) {
        case 'clear':
            return { Type: 'clear' };
        case 'stroke':
            return coerceStroke(op);
        case 'shape':
            return coerceShape(op);
        case 'text':
            return coerceText(op);
        default:
            return null;
    }
}

const SHAPE_KINDS = ['line', 'rect', 'ellipse', 'triangle', 'arrow'] as const;
type ShapeKind = (typeof SHAPE_KINDS)[number];

function coerceStroke(op: Record<string, unknown>): DrawOp | null {
    const rawPoints = op['Points'];
    if (!Array.isArray(rawPoints)) {
        return null;
    }
    const points: { X: number; Y: number }[] = [];
    for (const p of rawPoints) {
        if (typeof p === 'object' && p !== null) {
            const pt = p as Record<string, unknown>;
            points.push({ X: num(pt['X'], 0), Y: num(pt['Y'], 0) });
        }
    }
    if (points.length === 0) {
        return null;
    }
    return { Type: 'stroke', Points: points, Color: str(op['Color']) ?? '#000000', Width: num(op['Width'], 2) };
}

function coerceShape(op: Record<string, unknown>): DrawOp | null {
    const shape = op['Shape'];
    if (typeof shape !== 'string' || !SHAPE_KINDS.includes(shape as ShapeKind)) {
        return null;
    }
    return {
        Type: 'shape',
        Shape: shape as ShapeKind,
        X: num(op['X'], 0),
        Y: num(op['Y'], 0),
        W: num(op['W'], 0),
        H: num(op['H'], 0),
        Color: str(op['Color']) ?? '#000000',
        Width: num(op['Width'], 2),
    };
}

function coerceText(op: Record<string, unknown>): DrawOp | null {
    const text = str(op['Text']);
    if (text === undefined) {
        return null;
    }
    return {
        Type: 'text',
        X: num(op['X'], 0),
        Y: num(op['Y'], 0),
        Text: text,
        Color: str(op['Color']) ?? '#000000',
        FontSize: num(op['FontSize'], 16),
    };
}
