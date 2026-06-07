# Typed Block Streaming for Agent Runs

## Overview

MemberJunction agent runs stream their **interim** output as strongly-typed
content **blocks**. The block is the low-latency, intra-run, server→client unit
of "what the agent is producing, as it produces it."

A run's **terminal** result is unchanged: for Loop agents it is still the
`LoopAgentResponse` envelope (surfaced via `ExecuteAgentResult` + the persisted
`AIAgentRun`). Blocks are the streaming layer *on the way to* that result — they
never replace it.

A user turn is one discrete agent run. Interim blocks flow within the run; the
run ends with its structured terminal result. The next user turn is the next
run.

## The block

`AgentStreamBlock` (in `@memberjunction/ai-core-plus`) is a discriminated union
keyed by `Kind`:

| Kind | Meaning | Rendered as |
|------|---------|-------------|
| `text` | user-facing prose | markdown in chat / spoken by TTS |
| `thinking` | reasoning / scratch | de-emphasized, optional |
| `tool-call` | an in-flight action / sub-agent (with `running → complete/error` lifecycle, correlated by `CallID`) | live status chip |
| `tool-result` | the settled result of a `tool-call` | merged into its chip by `CallID` |
| `html` | rich agent-authored markup (e.g. SVG) | sanitized inline render |

**The block's `Kind` is its rendering contract.** A `text` block is prose at the
source; an `html` block is its markup at the source. There is no envelope to
crack open downstream — a consumer switches on `Kind` and renders. Nothing
structural (no JSON wrapper) ever enters the stream, so nothing has to be
extracted out of it.

## Where blocks originate

Blocks are emitted natively by `BaseAgent` during execution, over the existing
`AgentExecutionStreamingCallback` (`onStreaming`).

- **Loop agents** — whose model emits a structured `LoopAgentResponse` JSON
  object — convert that JSON to blocks **at the agent's own edge**: the prose
  `message` is streamed as `text` block deltas, and action / sub-agent decisions
  are streamed as `tool-call` blocks. The JSON envelope never leaves the agent;
  every consumer sees only blocks. (The streaming JSON→text adaptation lives in
  one place — the Loop agent's edge — not in any downstream/channel-specific
  step.)
- **Block-native brains** — a model emitting native text + tool content blocks —
  emit blocks directly, with no conversion at all.

Both coexist. The Loop edge-adapter is simply one producer of blocks among
others; adding a block-native brain is **additive**, not a teardown.

## Transport

Blocks ride the streaming construct that already exists — no new transport:

```
BaseAgent.onStreaming({ block })
  → RunAIAgentResolver streaming callback
    → PubSub publish on PUSH_STATUS_UPDATES_TOPIC  (data.streaming.block)
      → client subscription, routed by ConversationDetailID
```

The `AgentExecutionStreamingCallback` chunk carries an optional `block` field
alongside the existing `content`; it is serialized into the same push-status
payload the client already consumes.

## Rendering

The conversations chat (`@memberjunction/ng-conversations`) accumulates blocks
per in-progress message and renders by `Kind`:

- `text` / `thinking` — markdown (consecutive deltas coalesced into one growing
  bubble).
- `tool-call` — a live chip showing the label + a `running → ✓ / ✗` state,
  upserted by `CallID` so a call renders as one evolving row; a `tool-result`
  with the same `CallID` settles it.
- `html` — sanitized inline markup.

On completion the streamed blocks give way to the message's persisted terminal
content. Other surfaces (e.g. voice) consume the same block stream — `text`
blocks drive text-to-speech, etc.

## Interruption

A run can be cancelled mid-flight via `CancelAIAgentRun(conversationDetailId)`,
which aborts the run's `AbortController`; `BaseAgent` observes the cancellation
through its `cancellationToken` at each step. The chat exposes this as a STOP
control shown while a response is pending; realtime modalities map a user
interruption onto the same cancel.

## Extensibility

Agent execution is pluggable by **agent type** — `BaseAgentType` subclasses
resolved by `AIAgentType.DriverClass` (Loop, Flow, …). The typed-block stream is
uniform across types, so a new brain produces and renders through the same
pipeline with no channel- or surface-specific parsing. This is what lets new
modalities (including realtime speech-to-speech, modeled as its own agent type)
plug into one streaming + rendering contract.

## Summary

- **Terminal result:** `LoopAgentResponse` / `AIAgentRun` (unchanged).
- **Interim stream:** strongly-typed `AgentStreamBlock`s, intra-run,
  server→client.
- **Contract:** the block's `Kind` is its rendering contract; no JSON on the
  wire, nothing to extract downstream.
- **Origin:** native from `BaseAgent`; Loop agents adapt JSON→blocks at their own
  edge; block-native brains emit natively; additive coexistence.
- **Transport / UI:** the existing `onStreaming` → PubSub path and the existing
  conversations chat — no new infrastructure.
