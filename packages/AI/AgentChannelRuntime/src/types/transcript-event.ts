/**
 * `ChannelTranscriptEvent` — runtime-level transcript notification emitted by
 * a channel engine for transport-out display (widget transcript pane,
 * actionable-command chips, debugging logs).
 *
 * Why a callback (rather than a returned `AsyncIterable`): engines already
 * own their per-turn state machine and the events fire from multiple paths
 * (STT finals, message-field extractor output, post-execution payload).
 * A callback keeps wiring local to each emission site without forcing the
 * engine to maintain a pending-event buffer.
 *
 * The callback is provided by the caller (the GraphQL resolver in MJServer
 * publishes these to a `CHANNEL_TRANSCRIPT` pubsub topic for the voice
 * widget). The runtime itself stays transport-agnostic — it doesn't know
 * about GraphQL, PubSub, or any specific subscriber.
 *
 * Discriminated by `Kind`:
 *
 *  - `user`           — what the user said/typed this turn. Final transcripts
 *                       arrive once per turn.
 *  - `assistant-text` — partial assistant text as the message-field extractor
 *                       emits it from the streaming JSON envelope. May fire
 *                       many times per turn; concatenate on the consumer side.
 *  - `agent-response` — full structured response after `BaseAgent.Execute()`
 *                       returns. Carries `ActionableCommands` for the chip
 *                       UI and the final assembled `Message` for display.
 *  - `error`          — surface a turn-level error (e.g. agent execution
 *                       failure) without taking down the session.
 *  - `draw-op`        — a single drawing operation the agent performs on the
 *                       shared whiteboard. The widget renders it locally onto
 *                       the canvas. Rides the same transcript path as
 *                       `tool-call` blocks.
 */
export type ChannelTranscriptEvent =
    | UserTranscriptEvent
    | AssistantTextEvent
    | AgentResponseEvent
    | ToolCallBlockEvent
    | DrawOpBlockEvent
    | TranscriptErrorEvent;

/**
 * A single drawing operation. Coordinates are normalized 0..1 (origin
 * top-left) so canvas size is irrelevant. `Color` is a CSS color string.
 * `Width` / `FontSize` are pixels at render time.
 */
export type DrawOp =
    | { Type: 'stroke'; Points: { X: number; Y: number }[]; Color: string; Width: number }
    | {
          Type: 'shape';
          Shape: 'line' | 'rect' | 'ellipse' | 'triangle' | 'arrow';
          X: number;
          Y: number;
          W: number;
          H: number;
          Color: string;
          Width: number;
      }
    | { Type: 'text'; X: number; Y: number; Text: string; Color: string; FontSize: number }
    /**
     * Place a raster image on the canvas. `Src` is an image URL or a base64
     * data URI (e.g. `data:image/png;base64,…`). `X`/`Y` are the top-left
     * anchor and `W`/`H` the bounding-box size, all normalized 0..1.
     */
    | { Type: 'image'; Src: string; X: number; Y: number; W: number; H: number }
    /**
     * Place inline SVG on the canvas. `Markup` is the raw SVG markup string
     * (e.g. `<svg …>…</svg>`). `X`/`Y` are the top-left anchor and `W`/`H` the
     * bounding-box size into which the markup is scaled, all normalized 0..1.
     */
    | { Type: 'svg'; Markup: string; X: number; Y: number; W: number; H: number }
    | { Type: 'clear' };

export interface UserTranscriptEvent {
    Kind: 'user';
    /** What the user said / typed for this turn. */
    Text: string;
    /** `true` for finalized transcripts (the only kind we currently emit). */
    IsFinal: boolean;
}

export interface AssistantTextEvent {
    Kind: 'assistant-text';
    /** Incremental chunk of the assistant's `message` field, ready to display. */
    Text: string;
    /**
     * `true` when this is the last chunk for the current step. Consumers can
     * use this to commit the line. For prototype we leave this `false` on
     * mid-stream chunks and don't currently emit a final sentinel — the
     * subsequent `agent-response` event serves as the end marker.
     */
    IsFinal: boolean;
}

export interface AgentResponseEvent {
    Kind: 'agent-response';
    /**
     * The fully assembled `message` field from the agent's final
     * `LoopAgentResponse` payload. May be absent for action-only steps.
     */
    Message?: string;
    /**
     * Pass-through of `LoopAgentResponse.actionableCommands` — clickable
     * follow-up actions ("Open record X", "Run report Y"). Widget renders
     * them as chips below the transcript.
     *
     * Typed as `unknown[]` here so the runtime package doesn't take a
     * dependency on `@memberjunction/ai-core-plus`'s `ActionableCommand`
     * shape — consumers cast as appropriate. The shape is stable and
     * documented in `ai-core-plus`.
     */
    ActionableCommands?: unknown[];
    /** Pass-through of `LoopAgentResponse.responseForm` for input prompts. */
    ResponseForm?: unknown;
}

/**
 * A tool-call "block" — the unit that makes the block stream *functional*, not
 * just text. Emitted when a (realtime or cascaded) agent invokes a tool/sub-agent
 * mid-conversation, with a lifecycle the UI renders as a live progress block:
 *   `running`  → the tool/sub-agent is executing (show spinner + elapsed)
 *   `complete` → finished; `Detail` carries a short result summary
 *   `error`    → failed; `Detail` carries the message
 *
 * This is what gives "delegate to Code Smith and calculate the loan interest"
 * visible, low-latency progress instead of dead air — and proves the agent
 * actually did work (vs. a model just claiming it did).
 */
export interface ToolCallBlockEvent {
    Kind: 'tool-call';
    /** Provider-correlated call id (also used to upsert the block in the UI). */
    CallID: string;
    /** Tool/function invoked, e.g. `delegate_to_agent`. */
    ToolName: string;
    /** Human-readable label, e.g. "Delegating to Code Smith…". */
    Label: string;
    /** Lifecycle stage of this block. */
    Status: 'running' | 'complete' | 'error';
    /** Short args summary (on running) or result/error snippet (on complete/error). */
    Detail?: string;
}

/**
 * A drawing "block" — the unit that makes the whiteboard channel *functional*.
 * Emitted when the agent draws on the shared whiteboard (e.g. a tutoring
 * diagram), one event per `DrawOp`. The widget renders each op locally onto
 * the canvas the student is looking at.
 *
 * Mirrors `ToolCallBlockEvent` in spirit: it rides the same transcript path
 * (`ctx.OnTranscript?.({...})`), is correlated by `OpID` for dedupe/ordering,
 * and `Source` is always `'agent'` (student-drawn strokes are captured locally
 * and sent back as canvas snapshots, not as transcript events).
 */
export interface DrawOpBlockEvent {
    Kind: 'draw-op';
    /** Correlation id for dedupe / ordering of drawing ops. */
    OpID: string;
    /** Outbound draw ops are always agent-sourced (student renders locally). */
    Source: 'agent';
    /** The drawing operation to render. */
    Op: DrawOp;
}

export interface TranscriptErrorEvent {
    Kind: 'error';
    /** Human-readable error message — surface in the widget. */
    Message: string;
}

/** Callback signature for transcript events. Synchronous fire-and-forget. */
export type ChannelTranscriptListener = (event: ChannelTranscriptEvent) => void;

/**
 * Input passed to the `OnTaskGraph` callback when a conversation-manager
 * agent (Sage) emits a `taskGraph` payload requesting multi-agent
 * orchestration. The callback is responsible for actually running the
 * graph — same code path the chat surface uses via the `ExecuteTaskGraph`
 * GraphQL mutation, just invoked in-process.
 *
 * Keeps the runtime package transport-agnostic: it doesn't know about
 * GraphQL, PubSub, or `TaskOrchestrator`. The MJServer resolver provides
 * a callback that wires those in.
 */
export interface TaskGraphInvocation {
    /**
     * The raw taskGraph object from the agent's `result.payload.taskGraph`.
     * Shape matches `TaskGraphResponse` in `@memberjunction/server`:
     *   `{ workflowName, reasoning, tasks: [{ agentName, ... }] }`.
     * Typed as `unknown` here so the runtime package doesn't pin to the
     * server's exact type definition.
     */
    TaskGraph: unknown;
    /**
     * The conversation-detail ID for the agent-response row produced by the
     * conversation-manager (Sage). The orchestrator writes new
     * ConversationDetail rows that link back to this row for threading.
     */
    ConversationDetailID: string;
}

/** Result of a `OnTaskGraph` callback invocation. */
export interface TaskGraphResult {
    /**
     * Aggregated user-facing message text after the graph finishes — what
     * voice should TTS. May be the final task's output, a synthesized
     * summary, or whatever the orchestrator chooses to surface.
     */
    Message: string;
    /**
     * Optional: ID of the final ConversationDetail row holding the
     * aggregated result, in case the engine needs to link back to it.
     */
    ConversationDetailID?: string;
}

/**
 * Callback signature for executing a `taskGraph` server-side. The MJServer
 * resolver provides an impl backed by `TaskOrchestrator`.
 */
export type ChannelTaskGraphHandler = (
    invocation: TaskGraphInvocation
) => Promise<TaskGraphResult>;
