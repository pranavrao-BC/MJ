/**
 * @fileoverview Implementation of the Realtime Agent Type for native speech-to-speech (S2S) agent runs.
 *
 * Where `LoopAgentType` drives a turn-by-turn prompt loop and `FlowAgentType` walks a
 * deterministic graph, `RealtimeAgentType` runs a single long-lived bidirectional audio
 * session against a realtime model (GPT Realtime, Gemini Live). There is no prompt loop:
 * the model ingests audio and emits audio directly, doing its own VAD/endpointing
 * server-side. This agent type's job is the bridge between that model session and the
 * run's `realtimeTransport` (audio in/out + text/image control + session-end), plus
 * routing the model's native tool calls back through real MJ agent execution.
 *
 * It is the in-framework counterpart to `RealtimeChannelEngine` (in
 * `@memberjunction/ai-agentchannelruntime`): the session logic here is ported from that
 * engine, but it runs as a native `AIAgentRun` driven by `BaseAgent` rather than as a
 * standalone channel engine. The channel engine remains a working fallback.
 *
 * Lifecycle mapping onto the `BaseAgentType` surface:
 *   - `DetermineInitialStep` opens the S2S session and drives it to completion, returning
 *     a terminal step. Because a realtime session is one long-lived bridge (not a series
 *     of prompt turns), the whole session runs inside this single call; `BaseAgent`
 *     returns the terminal step directly without entering its prompt machinery.
 *   - `DetermineNextStep` / `PreProcessNextStep` therefore never drive a second turn —
 *     they terminate defensively if ever reached.
 *   - `GetPromptForStep` returns null (no prompt), `InjectPayload` is a no-op,
 *     `RequiresAgentLevelPrompts` is false (realtime agents need no prompt rows),
 *     `HandleStepFallback` terminates on Success/Failed.
 *
 * @module @memberjunction/ai-agents
 * @author MemberJunction.com
 * @since 5.40.0
 */

import { RegisterClass, MJGlobal } from '@memberjunction/global';
import { LogError, LogStatus, Metadata, RunView, UserInfo } from '@memberjunction/core';
import { MJAIModelEntity } from '@memberjunction/core-entities';
import {
    GetAIAPIKey,
    BaseRealtimeSpeech,
    type AudioFrame,
    type RealtimeSpeechConnectOptions,
    type RealtimeSpeechSession,
    type ToolCall,
    type ToolResult,
    type ToolDefinition,
    type ChatMessage,
} from '@memberjunction/ai';
import {
    AIPromptParams,
    AIPromptRunResult,
    BaseAgentNextStep,
    ExecuteAgentParams,
    AgentConfiguration,
    MJAIPromptEntityExtended,
    MJAIAgentEntityExtended,
    AgentStreamBlock,
    RealtimeAgentTransport,
    RealtimeAudioFrame,
    RealtimeControlEvent,
} from '@memberjunction/ai-core-plus';
import { BaseAgentType } from './base-agent-type';
import { AgentRunner } from '../AgentRunner';

/**
 * Marker prefixed onto a draw `html` block when the model requested `clear=false`
 * (append rather than replace the board). The realtime channel engine bridge
 * detects and strips this marker, suppressing the leading `clear` draw-op.
 * Exported so the engine bridge can match on the exact sentinel.
 *
 * @since 5.40.0
 */
export const DRAW_APPEND_MARKER = '<!--mj-draw-append-->';

/**
 * Tool exposed to the realtime model so it can hand work to another MJ agent
 * mid-conversation. When called, {@link RealtimeAgentType.delegateToAgent} runs the
 * named agent for real via `AgentRunner` and streams its progress back as blocks.
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
 * Built-in tool that lets the realtime model DRAW on the shared whiteboard the
 * user is looking at — the visual counterpart to talking. The model draws by
 * supplying a single inline `svg` string; {@link RealtimeAgentType.drawOnWhiteboard}
 * emits an `html` content block carrying that SVG, which the realtime channel
 * engine bridges into a `draw-op` the widget renders onto the canvas live.
 *
 * The schema is intentionally FLAT (top-level string/boolean only — no nested
 * arrays-of-objects). A nested `ops` schema made Gemini Live close the socket
 * with 1008, killing function-calling entirely. A single SVG string is also the
 * most precise way to draw a real diagram in one shot.
 *
 * Ported verbatim from the original `RealtimeChannelEngine`.
 */
const DRAW_ON_WHITEBOARD_TOOL: ToolDefinition = {
    Name: 'draw_on_whiteboard',
    Description:
        'Draw on the shared whiteboard the student is looking at by supplying clean inline SVG ' +
        'markup — diagrams, geometry, flowcharts, labeled figures, worked examples. Use this ' +
        'whenever a picture helps you teach, and narrate while you draw (e.g. draw a right ' +
        'triangle, then say what you drew). Use a viewBox like "0 0 100 100" and keep the SVG ' +
        'self-contained.',
    ParametersSchema: {
        type: 'object',
        properties: {
            svg: {
                type: 'string',
                description:
                    'Inline SVG markup to render on the whiteboard. Use a viewBox like ' +
                    '"0 0 100 100"; draw clean diagrams/figures/labels. This replaces the board ' +
                    'content unless you also set clear=false semantics — see clear.',
            },
            clear: {
                type: 'boolean',
                description: 'If true, wipe the whiteboard before drawing this SVG (default true).',
            },
        },
        required: ['svg'],
    },
};

/**
 * Appended to the system prompt whenever the `draw_on_whiteboard` tool is
 * offered. Realtime models will happily NARRATE a drawing without ever calling
 * the function unless told, in plain terms, that calling the tool is what makes
 * marks the user can see. Ported verbatim from the original engine.
 */
const WHITEBOARD_INSTRUCTIONS = [
    'You share a live whiteboard with the user. To put ANYTHING on it you MUST call the',
    '`draw_on_whiteboard` tool with inline SVG — describing a drawing in words does NOT draw it.',
    'Whenever a diagram, sketch, labeled figure, or worked example would help, actually call the',
    'tool, then narrate briefly what you drew. The board is LANDSCAPE: use a wide viewBox like',
    '"0 0 320 180" and spread your drawing across the FULL width and height so it is large and',
    'readable — never bunch it into a corner. Make strokes, shapes, and font sizes generous',
    '(e.g. font-size 12–18 in that viewBox). Keep the SVG self-contained. The user draws on the',
    'same board; you receive snapshots of their work as images, so react to what they draw.',
].join(' ');

/**
 * Realtime-agent execution params. The realtime model id is the one piece of
 * configuration this agent type needs that isn't on the agent record itself; it is
 * passed via `ExecuteAgentParams.agentTypeParams` so callers stay strongly typed.
 *
 * @since 5.40.0
 */
export interface RealtimeAgentExecuteParams {
    /** ID of the `MJ: AI Models` row for the realtime (S2S) model to open the session against. */
    realtimeModelId?: string;
    /** Optional extra system-prompt instructions appended to the synthesized prompt. */
    instructions?: string;
    /** Optional realtime tools to offer in addition to the built-in delegate tool. */
    extraTools?: ToolDefinition[];
}

/**
 * Tagged result of {@link RealtimeAgentType.resolveRealtimeProvider} — a discriminated
 * union so the caller can fail the run gracefully on the failure branch.
 */
type ResolvedRealtimeProvider =
    | { success: true; driver: BaseRealtimeSpeech; modelApiName: string | undefined }
    | { success: false; error: string };

/**
 * Implementation of the Realtime Agent Type pattern — a native S2S agent run.
 *
 * @class RealtimeAgentType
 * @extends BaseAgentType
 * @since 5.40.0
 */
@RegisterClass(BaseAgentType, 'RealtimeAgentType')
export class RealtimeAgentType extends BaseAgentType {
    /** Counts model→transport audio frames for the close-out log line. */
    private audioFrameCount = 0;
    /** Set once the session is ending so background pumps stop forwarding. */
    private stopped = false;

    // ------------------------------------------------------------------
    // BaseAgentType surface
    // ------------------------------------------------------------------

    /** Realtime agents keep no agent-type state. */
    public async InitializeAgentTypeState<ATS = any, P = any>(_params: ExecuteAgentParams<any, P>): Promise<ATS> {
        return {} as ATS;
    }

    /** Realtime agents need no agent-level prompt rows; the system prompt is synthesized. */
    public override get RequiresAgentLevelPrompts(): boolean {
        return false;
    }

    /** No prompt loop — there is never a prompt to run for a realtime step. */
    public async GetPromptForStep<P = any, ATS = any>(
        _params: ExecuteAgentParams,
        _config: AgentConfiguration,
        _payload: P,
        _agentTypeState: ATS,
        _previousDecision?: BaseAgentNextStep<P> | null
    ): Promise<MJAIPromptEntityExtended | null> {
        return null;
    }

    /** No prompt to inject a payload into. */
    public async InjectPayload<P = any, ATS = any>(
        _payload: P,
        _agentTypeState: ATS,
        _prompt: AIPromptParams,
        _agentInfo: { agentId: string; agentRunId?: string }
    ): Promise<void> {
        // No-op: realtime agents do not run prompts.
    }

    /**
     * The whole realtime session runs here. We open the S2S session, bridge it to the
     * run's transport until it ends or is cancelled, then return a terminal step.
     * `BaseAgent.executeNextStep` returns this initial step directly, so the run never
     * enters the prompt machinery.
     */
    public async DetermineInitialStep<P = any, ATS = any>(
        params: ExecuteAgentParams<P>,
        _payload: P,
        _agentTypeState: ATS
    ): Promise<BaseAgentNextStep<P> | null> {
        return this.runSession<P>(params);
    }

    /** A realtime run is single-shot; if a second turn is ever reached, terminate. */
    public async PreProcessNextStep<P = any, ATS = any>(
        _params: ExecuteAgentParams<P>,
        step: BaseAgentNextStep<P>,
        _payload: P,
        _agentTypeState: ATS
    ): Promise<BaseAgentNextStep<P> | null> {
        return this.terminalStep<P>(step.step === 'Failed' ? 'Failed' : 'Success', step.errorMessage);
    }

    /** Defensive: a realtime session resolves to a terminal step; never loop. */
    public async DetermineNextStep<P = any, ATS = any>(
        _promptResult: AIPromptRunResult | null,
        _params: ExecuteAgentParams<any, P>,
        _payload: P,
        _agentTypeState: ATS
    ): Promise<BaseAgentNextStep<P>> {
        return this.terminalStep<P>('Success');
    }

    /** Always terminate on Success/Failed — never fall back to prompt execution. */
    public override async HandleStepFallback<P = any, ATS = any>(
        step: BaseAgentNextStep<P>,
        _config: AgentConfiguration,
        _params: ExecuteAgentParams<P>,
        _payload: P,
        _agentTypeState: ATS
    ): Promise<BaseAgentNextStep<P> | null> {
        return this.terminalStep<P>(step.step === 'Failed' ? 'Failed' : 'Success', step.errorMessage);
    }

    // ------------------------------------------------------------------
    // Session lifecycle (ported from RealtimeChannelEngine)
    // ------------------------------------------------------------------

    /**
     * Open the S2S session, bridge it to the transport, and run until the control
     * stream ends or the run is cancelled. Returns a terminal step; never throws —
     * a missing transport / model / key resolves to a graceful Failed step.
     */
    private async runSession<P = any>(params: ExecuteAgentParams<P>): Promise<BaseAgentNextStep<P>> {
        const transport = params.realtimeTransport;
        if (!transport) {
            return this.terminalStep<P>(
                'Failed',
                'RealtimeAgentType requires params.realtimeTransport; none was provided.'
            );
        }

        let session: RealtimeSpeechSession | null = null;
        let disposeAbort: (() => void) | null = null;
        try {
            const resolved = await this.resolveRealtimeProvider(params);
            if (resolved.success === false) {
                return this.terminalStep<P>('Failed', resolved.error);
            }

            const opts = this.buildConnectOptions(params, resolved.modelApiName);
            LogStatus(`[RealtimeAgentType] connecting model='${resolved.modelApiName ?? '(default)'}'`);
            session = await resolved.driver.Connect(opts);

            this.wireSession(params, session);
            disposeAbort = this.wireCancellation(params, session);

            LogStatus('[RealtimeAgentType] session-open');
            // The control stream owns session lifetime (session-end / transport close).
            // The audio-in pump runs concurrently and must NOT end the session — for a
            // text-in transport AudioFramesIn completes immediately (no mic).
            const audioPump = this.pumpAudioIn(transport, session).catch(() => undefined);
            await this.consumeControlEvents(params, transport, session);
            this.stopped = true;
            await audioPump;

            LogStatus(`[RealtimeAgentType] session-closed audioFrames=${this.audioFrameCount}`);
            return this.terminalStep<P>('Success');
        } catch (err) {
            this.stopped = true;
            LogError(`[RealtimeAgentType] session error: ${errMsg(err)}`);
            return this.terminalStep<P>('Failed', errMsg(err));
        } finally {
            disposeAbort?.();
            if (session) {
                try {
                    await session.Close();
                } catch (closeErr) {
                    LogError(`[RealtimeAgentType] session close error: ${errMsg(closeErr)}`);
                }
            }
        }
    }

    /** Wire model output back to the transport + emit transcript/tool activity as blocks. */
    private wireSession<P>(params: ExecuteAgentParams<P>, session: RealtimeSpeechSession): void {
        session.OnAudio((frame) => {
            if (!this.stopped) {
                this.audioFrameCount++;
                params.realtimeTransport!.SendAudioFrame(toTransportFrame(frame));
            }
        });
        session.OnTranscript((text, role, isFinal) => {
            // Only assistant transcript becomes a streamed text block; user transcript
            // is the carrier's own input echo and isn't re-emitted here.
            if (role === 'assistant' && text.length > 0) {
                this.emitBlock(params, { Kind: 'text', Content: text });
            }
            void isFinal;
        });
        session.OnToolCall((call) => this.routeToolCall(params, call));
    }

    /** Bridge the run's cancellation token to barge-in/session cancel. */
    private wireCancellation<P>(params: ExecuteAgentParams<P>, session: RealtimeSpeechSession): (() => void) | null {
        const token = params.cancellationToken;
        if (!token) {
            return null;
        }
        const onAbort = (): void => {
            this.stopped = true;
            session.CancelCurrentResponse();
        };
        if (token.aborted) {
            onAbort();
            return null;
        }
        token.addEventListener('abort', onAbort);
        return () => token.removeEventListener('abort', onAbort);
    }

    /** Forward inbound transport audio to the session until stopped. */
    private async pumpAudioIn(transport: RealtimeAgentTransport, session: RealtimeSpeechSession): Promise<void> {
        try {
            for await (const frame of transport.AudioFramesIn) {
                if (this.stopped) {
                    return;
                }
                session.SendAudio(toSessionFrame(frame));
            }
        } catch (err) {
            if (!this.stopped) {
                LogError(`[RealtimeAgentType] audio-in pump failed: ${errMsg(err)}`);
            }
        }
    }

    /**
     * Forward `user-text` turns and `user-canvas-snapshot` images to the model, and
     * end the session on `session-end` (or when the control stream closes).
     */
    private async consumeControlEvents<P>(
        params: ExecuteAgentParams<P>,
        transport: RealtimeAgentTransport,
        session: RealtimeSpeechSession
    ): Promise<void> {
        try {
            for await (const ev of transport.ControlEventsIn) {
                if (this.stopped) {
                    return;
                }
                const control = ev as RealtimeControlEvent;
                if (control.Kind === 'session-end') {
                    return;
                }
                if (control.Kind === 'user-text' && control.Text) {
                    LogStatus(`[RealtimeAgentType] send-text len=${control.Text.length}`);
                    session.SendText(control.Text);
                }
                if (control.Kind === 'user-canvas-snapshot' && control.ImageBase64) {
                    LogStatus(`[RealtimeAgentType] send-image mediaType='${control.MediaType}'`);
                    session.SendImage(control.ImageBase64, control.MediaType ?? 'image/png');
                }
            }
        } catch (err) {
            if (!this.stopped) {
                LogError(`[RealtimeAgentType] control loop failed: ${errMsg(err)}`);
            }
        }
    }

    // ------------------------------------------------------------------
    // Tool routing (ported from RealtimeChannelEngine)
    // ------------------------------------------------------------------

    /** Route a native tool call from the model to real MJ execution. */
    private async routeToolCall<P>(params: ExecuteAgentParams<P>, call: ToolCall): Promise<ToolResult> {
        LogStatus(`[RealtimeAgentType] toolcall name='${call.Name}'`);
        if (call.Name === 'delegate_to_agent') {
            return this.delegateToAgent(params, call);
        }
        if (call.Name === 'draw_on_whiteboard') {
            return this.drawOnWhiteboard(params, call);
        }
        this.emitBlock(params, {
            Kind: 'tool-call',
            CallID: call.CallID,
            Name: call.Name,
            Status: 'error',
            Label: `Unknown tool: ${call.Name}`,
            Detail: 'No handler registered.',
        });
        return { CallID: call.CallID, Error: `Tool '${call.Name}' is not available.` };
    }

    /**
     * Execute `delegate_to_agent`: resolve the named MJ agent and run it for real via
     * `AgentRunner`, streaming a running → complete tool-call block (plus the delegated
     * run's own native blocks) and returning the agent's answer to the realtime model.
     */
    private async delegateToAgent<P>(params: ExecuteAgentParams<P>, call: ToolCall): Promise<ToolResult> {
        const agentName = String(call.Arguments['agent_name'] ?? '').trim();
        const task = String(call.Arguments['task'] ?? '').trim();
        this.emitBlock(params, {
            Kind: 'tool-call',
            CallID: call.CallID,
            Name: call.Name,
            Status: 'running',
            Label: `Delegating to ${agentName || 'agent'}…`,
            Detail: task.length > 80 ? task.slice(0, 80) + '…' : task,
        });
        const startedMs = Date.now();
        try {
            const agent = await this.resolveAgentByName(agentName, params.contextUser);
            if (!agent) {
                const msg = `Agent '${agentName}' not found.`;
                this.emitBlock(params, {
                    Kind: 'tool-call', CallID: call.CallID, Name: call.Name,
                    Status: 'error', Label: `${agentName}: not found`, Detail: msg,
                });
                return { CallID: call.CallID, Error: msg };
            }

            const delegated: ExecuteAgentParams = {
                agent,
                conversationMessages: [{ role: 'user', content: task }] as ChatMessage[],
                contextUser: params.contextUser,
                provider: params.provider,
                cancellationToken: params.cancellationToken,
                // Forward the delegated run's native block stream up to the parent run's
                // onStreaming so the voice surface sees MJ's native AgentStreamBlock
                // streaming live during delegation, not just the final answer.
                onStreaming: (chunk) => this.forwardDelegatedBlock(params, chunk.block),
            };
            const result = await new AgentRunner().RunAgent(delegated);
            const ok = result.success === true;
            const answer =
                result.agentRun?.Message?.trim() ||
                (ok ? '(the agent returned no message)' : (result.agentRun?.ErrorMessage ?? 'agent failed'));
            const secs = ((Date.now() - startedMs) / 1000).toFixed(1);

            this.emitBlock(params, {
                Kind: 'tool-call', CallID: call.CallID, Name: call.Name,
                Status: ok ? 'complete' : 'error',
                Label: `${agentName} ${ok ? 'done' : 'failed'} (${secs}s)`,
                Detail: answer.length > 140 ? answer.slice(0, 140) + '…' : answer,
            });
            return ok ? { CallID: call.CallID, Result: answer } : { CallID: call.CallID, Error: answer };
        } catch (err) {
            LogError(`[RealtimeAgentType] delegate-failed agent='${agentName}': ${errMsg(err)}`);
            this.emitBlock(params, {
                Kind: 'tool-call', CallID: call.CallID, Name: call.Name,
                Status: 'error', Label: `${agentName}: error`, Detail: errMsg(err),
            });
            return { CallID: call.CallID, Error: errMsg(err) };
        }
    }

    /**
     * Execute the built-in `draw_on_whiteboard` tool: render the model's inline
     * SVG onto the shared canvas by emitting an `html` content block carrying the
     * markup. The realtime channel engine bridges that `html` block into a
     * `draw-op` (`Type:'svg'`) the widget renders via Fabric.
     *
     * The `clear` flag (default true) controls whether the board is wiped first.
     * Because the `html` block has no clear field, `clear=false` is encoded as a
     * leading `<!--mj-draw-append-->` marker that the engine bridge detects; any
     * other markup means "replace the board" (the common case).
     *
     * Empty `svg` is a graceful no-op — we never throw, so a malformed call from
     * the model can't abort the session.
     */
    private drawOnWhiteboard<P>(params: ExecuteAgentParams<P>, call: ToolCall): ToolResult {
        const svg = String(call.Arguments['svg'] ?? '');
        const clear = call.Arguments['clear'] !== false;
        if (svg.trim().length === 0) {
            this.emitBlock(params, {
                Kind: 'tool-call', CallID: call.CallID, Name: call.Name,
                Status: 'complete', Label: 'Whiteboard: nothing to draw', Detail: 'No SVG supplied.',
            });
            return { CallID: call.CallID, Result: 'no svg' };
        }

        this.emitBlock(params, {
            Kind: 'tool-call', CallID: call.CallID, Name: call.Name,
            Status: 'running', Label: '✏️ Drawing on whiteboard…',
        });

        // Carry the SVG on an `html` block; the engine bridge maps it to a draw-op.
        // `clear=false` is signalled with a leading marker the bridge strips off.
        const html = clear ? svg : `${DRAW_APPEND_MARKER}${svg}`;
        this.emitBlock(params, { Kind: 'html', Html: html });

        LogStatus(`[RealtimeAgentType] draw svgLen=${svg.length} clear=${clear}`);
        this.emitBlock(params, {
            Kind: 'tool-call', CallID: call.CallID, Name: call.Name,
            Status: 'complete', Label: '✏️ Drew on whiteboard',
        });
        return { CallID: call.CallID, Result: 'drew svg' };
    }

    /**
     * Fuzzy-resolve an active agent by name. The model rarely says the exact registered
     * name ("Code Smith" vs "Codesmith Agent"); match on a normalized (lowercased,
     * alnum-only) form, exact first then substring.
     */
    private async resolveAgentByName(
        agentName: string,
        contextUser?: UserInfo
    ): Promise<MJAIAgentEntityExtended | null> {
        const rv = new RunView();
        const found = await rv.RunView<MJAIAgentEntityExtended>(
            { EntityName: 'MJ: AI Agents', ExtraFilter: `Status='Active'`, ResultType: 'entity_object' },
            contextUser
        );
        const agents = found.Success ? (found.Results ?? []) : [];
        const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const want = norm(agentName);
        if (want.length === 0) {
            return null;
        }
        return (
            agents.find((a) => norm(a.Name) === want) ??
            agents.find((a) => norm(a.Name).includes(want) || want.includes(norm(a.Name))) ??
            null
        );
    }

    /**
     * Map a delegated run's native `AgentStreamBlock` onto the parent run's stream.
     * `tool-call` and `text` blocks pass through; `thinking` / `tool-result` / `html`
     * are skipped on the voice path (the model speaks the answer).
     */
    private forwardDelegatedBlock<P>(params: ExecuteAgentParams<P>, block: AgentStreamBlock | undefined): void {
        if (!block) {
            return;
        }
        if (block.Kind === 'tool-call' || block.Kind === 'text') {
            this.emitBlock(params, block);
        }
    }

    // ------------------------------------------------------------------
    // Provider resolution (ported from RealtimeChannelEngine)
    // ------------------------------------------------------------------

    /**
     * Resolve the realtime model row, its driver class + API model name, the API key,
     * and instantiate the registered `BaseRealtimeSpeech` driver. Returns a tagged
     * result rather than throwing so callers can fail the run gracefully.
     */
    private async resolveRealtimeProvider<P>(
        params: ExecuteAgentParams<P>
    ): Promise<ResolvedRealtimeProvider> {
        const typeParams = (params.agentTypeParams ?? {}) as RealtimeAgentExecuteParams;
        const modelId = typeParams.realtimeModelId;
        if (!modelId) {
            return {
                success: false,
                error: 'RealtimeAgentType: no realtime model id provided (agentTypeParams.realtimeModelId).',
            };
        }

        const md = new Metadata();
        const model = await md.GetEntityObject<MJAIModelEntity>('MJ: AI Models', params.contextUser);
        const loaded = await model.Load(modelId);
        if (!loaded) {
            return { success: false, error: `RealtimeAgentType: Realtime AIModel not found for ID='${modelId}'.` };
        }

        const { driverClass, apiName } = await this.resolveDriverAndApiName(model, params.contextUser);
        if (!driverClass) {
            return {
                success: false,
                error: `RealtimeAgentType: Realtime AIModel '${model.Name}' has no DriverClass (checked model row and vendor rows).`,
            };
        }
        const apiKey = GetAIAPIKey(driverClass);
        if (!apiKey) {
            return {
                success: false,
                error: `RealtimeAgentType: no API key for DriverClass='${driverClass}'. Set env AI_VENDOR_API_KEY__${driverClass}.`,
            };
        }
        const driver = MJGlobal.Instance.ClassFactory.CreateInstance<BaseRealtimeSpeech>(
            BaseRealtimeSpeech,
            driverClass,
            apiKey
        );
        if (!driver) {
            return {
                success: false,
                error: `RealtimeAgentType: no BaseRealtimeSpeech registered for DriverClass='${driverClass}'.`,
            };
        }
        return { success: true, driver, modelApiName: apiName };
    }

    /**
     * Resolve driver class + API model name, preferring the AIModel row's own fields and
     * falling back to its highest-priority active vendor row that specifies a DriverClass.
     */
    private async resolveDriverAndApiName(
        model: MJAIModelEntity,
        contextUser?: UserInfo
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

    /** Synthesize the S2S system prompt from the agent record + offer the delegate tool. */
    private buildConnectOptions<P>(
        params: ExecuteAgentParams<P>,
        modelApiName: string | undefined
    ): RealtimeSpeechConnectOptions {
        const typeParams = (params.agentTypeParams ?? {}) as RealtimeAgentExecuteParams;
        const agent = params.agent;
        const systemPrompt = [
            agent.Name ? `You are ${agent.Name}.` : '',
            agent.Description ?? '',
            'You are speaking with the user by voice. Keep replies concise and conversational; avoid markdown, code blocks, and long lists.',
            WHITEBOARD_INSTRUCTIONS,
            typeParams.instructions ?? '',
        ]
            .filter((s) => s.length > 0)
            .join('\n\n');

        // Built-in tools: delegate + whiteboard draw. extraTools are appended so
        // callers can offer additional realtime tools without losing the built-ins.
        const tools: ToolDefinition[] = [DELEGATE_TOOL, DRAW_ON_WHITEBOARD_TOOL, ...(typeParams.extraTools ?? [])];
        return {
            SystemPrompt: systemPrompt,
            ModelAPIName: modelApiName,
            ContextUser: params.contextUser as RealtimeSpeechConnectOptions['ContextUser'],
            Tools: tools,
        };
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /** Emit an interim content block on the parent run's streaming callback. */
    private emitBlock<P>(params: ExecuteAgentParams<P>, block: AgentStreamBlock): void {
        params.onStreaming?.({ content: '', isComplete: false, block });
    }

    /** Build a terminal next step (Success or Failed, always terminating). */
    private terminalStep<P>(step: 'Success' | 'Failed', errorMessage?: string): BaseAgentNextStep<P> {
        return { step, terminate: true, errorMessage } as BaseAgentNextStep<P>;
    }
}

/** Convert a session `AudioFrame` (Uint8Array) to a base64 transport frame. */
function toTransportFrame(frame: AudioFrame): RealtimeAudioFrame {
    return {
        Data: Buffer.from(frame.data).toString('base64'),
        SampleRateHz: frame.sampleRateHz,
        ChannelCount: frame.channelCount,
        MediaType: frame.mediaType,
    };
}

/** Convert a base64 transport frame to a session `AudioFrame` (Uint8Array). */
function toSessionFrame(frame: RealtimeAudioFrame): AudioFrame {
    return {
        data: new Uint8Array(Buffer.from(frame.Data, 'base64')),
        sampleRateHz: frame.SampleRateHz,
        channelCount: frame.ChannelCount,
        mediaType: frame.MediaType ?? 'audio/pcm',
    };
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
