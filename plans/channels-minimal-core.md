# Channels — The Minimal Core

**Status:** proposed core + green proof. Standalone artifact (`packages/AI/AgentChannelRuntime/src/actor-core.ts`), intentionally **not** wired into the live engines or widget yet.
**Companion:** [`channels-architecture-position.md`](./channels-architecture-position.md) frames the decision (one Channel primitive vs three, the Session+N-Surfaces refactor) against the *live* plumbing. This doc argues the *aesthetic* — the smallest thing that is still the whole model. Read that one for the wiring debate; this one for the shape.

---

## 1. The model in one breath

Three nouns. That is the entire model.

- **Block** — the unit. Its `Kind` **is** its format: `text`, `audio`, `draw`, `tool`, `tool_result`, `thinking`.
- **BlockStream** — a bidirectional, typed stream of blocks: `AsyncIterable<Block>` paired with `result()`.
- **Actor** — `(input: BlockStream) => BlockStream`. **THE** universal primitive. *Everything is an Actor*: the agent, a channel, a tool, a sub-agent, the LLM brain. Reads blocks, writes blocks.

A **Channel** is no longer a top-level concept — it is just **a human-facing Actor** (one that renders by `Kind` and emits user input back as blocks). That is the upgrade over the earlier framing: the old `Channel` interface generalizes to `Actor`, and the things that used to be separate machinery — delegation, the agent loop, rendering — all collapse into *Actors wired to Actors*.

```
            ┌────────────────────────────────────────┐
            │            ONE AGENT TURN               │
            │   agentActor = Brain + Tools (composite)│
            └─────────────────────┬───────────────────┘
                                  │  emits a BlockStream
                                  │  text | audio | draw | tool | tool_result | thinking
                  ┌───────────────┼───────────────────────────┐
                  │               │                            │
   a `tool` block routes      text/thinking            the whole stream fans out
   to a Tool-Actor (or a      flow straight             to N human-facing Actors
   sub-agent-Actor)           through                   (channels), each its OWN clock
                  │               │                            │
                  ▼               ▼          ┌─────────┬───────┴───────┬──────────┐
            ┌───────────┐   (flows out)      ▼         ▼               ▼          ▼
            │ TOOL-ACTOR│                ┌────────┐┌────────┐    ┌──────────┐
            │ calc /    │  tool_result   │  TEXT  ││  VOICE │    │WHITEBOARD│
            │ sub-agent ├──── fed back ──┤ {text} ││{text,  │    │ {draw}   │
            │ (delegate)│  into Brain +  │typewri-││ audio} │    │  paint   │
            └───────────┘  out to stream │ ter    ││ audio  │    │  clock   │
                                         └────────┘│ clock  │    └──────────┘
            delegation = Actor           Emit? (user input flows back
            calling an Actor             upstream as blocks) ──────────►
```

One turn, one BlockStream, N Actors at independent clocks. Delegation is the agent-Actor calling a tool-Actor. Nothing else is a primitive.

---

## 2. The decisive principle: format = `Kind`

> Actors route by `Kind`; no JSON envelope ever reaches a human-facing Actor.

This is still the load-bearing decision. A block's type *is* its rendering contract — a `text` block is prose at the source, an `audio` block is PCM at the source. There is no envelope to crack open downstream.

What this kills: the **JSON-envelope detour**. Today MJ's loop agent emits one structured-JSON envelope per turn, and a `MessageFieldExtractor` digs the `message` field out of streaming JSON mid-flight so the voice path can speak prose, not a JSON blob. Under format-as-Kind, "don't output JSON to a channel" stops being a *filtering step* and becomes a *property of the type system*: prose was a `text` block all along; nothing structural ever entered the stream, so nothing has to be extracted out of it. The extractor's job is deleted, not relocated.

This composes upward into the Actor model: the JSON `LoopAgentResponse` envelope **evaporates** for a block-native brain. The brain emits `text` + `tool` blocks *natively* — that is the model's real language, not a JSON shell wrapped around it. MJ's existing JSON Loop agent doesn't disappear; it becomes **one legacy Actor** that adapts JSON → blocks at its edge. The two coexist. This is **additive, not a teardown.**

---

## 3. The core, in code

The whole substrate is `actor-core.ts` — three types and one composite. `Actor` generalizes the earlier `Channel` seed in `channel-core.ts` (a channel was already "a thing that consumes blocks by Kind"; an Actor is that, made bidirectional and self-similar so a brain, a tool, and a sub-agent are the *same* type).

```ts
// The unit. Kind = format. (adds tool/tool_result to the channel-core block set)
export type Block =
    | { Kind: 'text'; Text: string }
    | { Kind: 'audio'; Data: Uint8Array; SampleRateHz: number; ChannelCount: number }
    | { Kind: 'draw'; Op: DrawOp }
    | { Kind: 'tool'; CallID: string; Name: string; Arguments: Record<string, unknown> }
    | { Kind: 'tool_result'; CallID: string; Result?: string; Error?: string }
    | { Kind: 'thinking'; Text: string };

// Dual stream/result. iterate for live, result() for the assembled set.
export interface BlockStream extends AsyncIterable<Block> {
    result(): Promise<Block[]>;
}

// THE primitive: an Actor reads blocks and writes blocks. Everything is one.
export type Actor = (input: BlockStream) => BlockStream;
```

That is the *entire* model. The agent is just a composite Actor — `agentActor` — that wires a Brain Actor to a set of Tool Actors with an internal feedback loop:

```ts
export function agentActor(opts: { Brain: Actor; Tools: Record<string, Actor> }): Actor {
    // ...
    for await (const block of Brain(toStream(brainInput))) {
        output.push(block); // tool / text / thinking / draw / audio all flow out immediately
        if (block.Kind === 'tool') {
            toolRuns.push(runTool(block)); // concurrent — do NOT await, the brain keeps going
        }
    }
    // ...
}
```

The trick that makes "talk while you delegate" fall out for free is an async push-queue (`BlockQueue`): the Brain's *input* stays a live queue, so a `tool_result` can be fed back **after** the Brain has already started emitting filler text — `runTool` pushes each result *both* back into `brainInput` (so the Brain can react) *and* out to `output` (so a channel can render it). The Brain never blocks on a tool.

**The proof** — `actor-core.test.ts`, **5/5 green** — asserts exactly the architecture, no more. One scene: an agent that talks while it delegates, a tool that answers asynchronously, a sub-agent wired *identically* to a tool, and a channel that renders purely by Kind.

- **delegation = Actor calling Actor** — the `calc` tool runs and its `tool_result` flows into the agent's output; a `subAgent` Actor sits in the same `Tools` map, same shape. No delegation primitive exists.
- **talk-while-delegating** — `'…still with you while that runs…'` is emitted *before* the `tool_result` (`fillerIndex < resultIndex`): the brain never stalls on the tool.
- **the loop closes on the result** — `'the answer is 4.'` comes *after* the `tool_result` is fed back in.
- **render-by-Kind** — a `textChannel` Actor draining the agent collects *exactly* the 3 `text` blocks, no `tool`/`tool_result`. Rendering is wiring a channel-Actor to the output.
- **dual stream/result** — `streamOf([...]).result()` returns the full array; the same object is `for await`-able.

`channel-core.ts` remains as the earlier seed (`Channel` + `RunChannels` fan-out) — now understood as a *special case*: a fixed, one-directional, render-only Actor. `Actor` subsumes it.

---

## 4. Why minimal ≠ lossy

The discipline is the point: the features that *look* like missing primitives are all "the Actor model done right." None earns a top-level concept.

- **Delegation** → an **Actor calling an Actor.** A sub-agent is an Actor wired into the `Tools` map; the brain emitting a `tool` block routes to it. This subsumes the `nextStep` switch, the `delegate_to_agent` tool, and `TaskOrchestrator` as the **same act** — message-passing between actors. No delegation primitive.
- **The agent loop itself** → blocks cycling between the brain-Actor and tool-Actors. There is no `nextStep` enum: a `tool` block routes to a tool-Actor, a `text` block flows out, and the turn is **done when the brain goes quiet** (its stream ends). The loop is emergent from the feedback queue, not a control structure.
- **Per-surface content differences** → different block **Kinds** on the one stream. Voice wants prose (`text`), the whiteboard wants `draw`, the inspector wants `tool` — distinct Kinds, not a `Transform` primitive between producer and channel.
- **Input fusion** → blocks flowing **upstream.** Channels emit; the brain consumes user-blocks (typed text, an audio frame, a click-as-draw). Making multimodal sense of several input blocks is *the brain's job* — no `Fusion` primitive, just the same union pointed the other way.
- **Sync / time** → an optional **field.** A timestamp on a block is a property you add to the union, not a clock primitive. The clocks live where they belong: inside each human-facing Actor.
- **TTS** (text → audio), the one genuinely irreducible adapter, isn't a primitive either — it's simply *what a voice-Actor does to `text` blocks* on its way to producing sound. It lives inside that Actor, not in the model.

---

## 5. Lineage

**earendil-works/pi.** Credit honestly: pi-ai models message content as a ~4-type content-block discriminated union (`text` / `thinking` / `image` / `toolCall`), streams via flat indexed events (`text_delta {contentIndex, delta}` …), and exposes one dual `AssistantMessageEventStream` that is both `AsyncIterable` and has `.result()`. pi is a *coding-agent* toolkit — domain-misaligned with MJ — so we took none of its domain model. We took the **aesthetic**: tiny discriminated unions, the type carries the meaning, one stream/result primitive, no class hierarchies. We kept MJ house casing — `Kind` discriminant, PascalCase fields — rather than pi's lowercase.

**MJ's own `AgentEventStream`** (`@memberjunction/ai-core-plus`, `agent-stream-events.ts`). MJ already has this shape: a dual `AsyncIterable<AgentStreamEvent>` + `result()`, with text / thinking / tool as separate event Kinds and errors-as-values. The Actor core is the **channel-facing unification** of that primitive, pointed at renderers *and* producers. `AgentEventStream` is the token-level producer substrate; `BlockStream` is what any Actor reads and writes. Same aesthetic, same dual contract, one layer out.

**The actor model.** The naming — **Actor**, over *Transducer* or *Pipe* — is the actor-model lineage made explicit: a message in / a message out, composable, async. Sub-agents are sub-actors. "Talk while delegating" *is* async message passing — a parent actor that doesn't block on the child's reply. The composite agent is an actor whose behavior is "run the brain over my mailbox, spawn child actors for `tool` blocks, route their replies back into my mailbox." We chose Actor precisely because the agent loop, delegation, and concurrency are all already first-class in that model — we didn't have to invent them.

---

## 6. Status & what's deferred

**Done:** the proposed Actor core (`actor-core.ts`) + a passing proof (`actor-core.test.ts`, **5/5**), package builds clean. It is a standalone design artifact — it imports only `DrawOp` and stands on its own. `channel-core.ts` remains as the earlier seed the Actor type generalizes.

**Explicitly NOT yet true — this is a proven core, not shipped plumbing:**
- The **live rewire.** The running engines and the voice widget do not use `Actor` / `Block` yet; they still ride `AgentStreamEvent` + `ChannelTranscriptEvent` and the two pubsub topics. The live system still has **single-engine-per-session**, **emergent (not formalized) multi-channel**, **two coexisting normalized streams**, and **`MessageFieldExtractor`** in the cascaded path.
- The **legacy-Loop-agent-as-Actor adapter.** Making MJ's existing JSON Loop agent into the "one legacy Actor that adapts JSON → blocks" (§2) is designed, not built.
- The one honest fork that remains open: **where structured state/payload lives.** For a block-native brain it's a `state` block (or just the conversation history); for the legacy JSON Loop agent it's the explicit `payload` object. The two models coexist; this core doesn't force the choice.

The live rewire and the adapter are deferred decisions — sequencing and the one-primitive-vs-three call belong to the companion [`channels-architecture-position.md`](./channels-architecture-position.md), not here. This core is deliberately the smallest shape every option shares.
