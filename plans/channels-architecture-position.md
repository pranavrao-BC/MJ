# Channels — Architecture Position & Decision Doc

**Audience:** senior-eng review (Amith, Robert, Ethan)
**Status of this doc:** position / decision. It now leads with a **recommended model** — the **Actor** — and argues it from a green proof. It is still a decision doc: the room ratifies, the honest tradeoffs and the genuinely-open questions stay on the table.
**Worktree:** `MJ-voice-channels` (`pr2489-sync`). Every plumbing claim below was checked against the code in this branch; `path:Symbol` citations point at the verified source.
**Companion:** [`channels-minimal-core.md`](./channels-minimal-core.md) — the *aesthetic* deep-dive (smallest shape, format-as-`Kind`, lineage). This doc is the *decision*; that one is the *shape*. They share the same green core; this doc does not re-derive it.

Legend used throughout:
- **[PROVEN-CORE]** — built as a standalone artifact with a green test, but **NOT wired into the live system**.
- **[PROTOTYPE]** — built and exercised live, rough edges, demo-caliber.
- **[DESIGNED]** — proposed in this doc / plans, not yet built.
- **[SPECULATIVE]** — future, sketched only.

---

## 1. The concept, and what we demo Monday

> *"A design direction called 'Channels' which allows MJ agents to declare channels they support — text, voice, video, interactive whiteboard, and in the future holograms. 1+ channel can be active at a given time. … each channel has its own 'speed' where tokens for Voice are played while tokens for text are shown at their own rates."* — the CTO framing we're honoring.

**Channels** lets an agent advertise *how it can be talked to* (text, voice-cascaded, voice-realtime, phone, video) as first-class metadata, and lets the runtime drive a live session over the declared channel. Monday's demo is **voice + text** specifically — typed input to an agent, with the agent's answer rendered as **on-screen text** *and* **spoken audio** at the same time, plus a **[PROTOTYPE]** whiteboard channel where a realtime model draws while it talks.

**Be explicit about caliber:** the live path is prototype plumbing. The text-in/voice-out path is solid and exercised; full mic-in WebRTC is wired but `WebRTCTransport.Open()` is still skeleton (`ChannelSessionResolver.ts` docstring, "KNOWN LIMITATION"). What we are reviewing is whether the **abstraction** is right, not whether the demo is production-ready. **And we did the design work** — §2 is no longer an open vote; it's a recommendation backed by a green proof (`actor-core.ts`, 5/5).

---

## 2. The recommendation: **Actor** is the one primitive

We converged on a single, small model. State it plainly, then prove it (§2.3), then argue the honest counter-case (§6).

### 2.1 Three nouns

- **Block** — the unit. Its `Kind` **is** its format: `text`, `audio`, `draw`, `tool`, `tool_result`, `thinking` (`actor-core.ts:Block`). There is no envelope to crack open downstream; prose is a `text` block *at the source*.
- **BlockStream** — a bidirectional, typed stream: `AsyncIterable<Block>` **plus** `result(): Promise<Block[]>` (`actor-core.ts:BlockStream`). Iterate it for live rendering; `await result()` for the assembled batch. One object serves both the voice path and the batch path.
- **Actor** — **`(input: BlockStream) => BlockStream`** (`actor-core.ts:Actor`). A thing that reads blocks and writes blocks. That is the whole primitive.

### 2.2 Everything is an Actor

The agent, each channel, each tool, each sub-agent, **and the LLM brain itself** are all Actors — the same signature, end to end. There are exactly two *shapes*:

- **Leaf Actor** — a tool, a channel, or the brain. Reads input blocks, writes output blocks, no internal routing. (In the proof: `calc`, `textChannel`, `Brain` — `actor-core.test.ts:27`, `:53`, `:13`.)
- **Composite Actor** — an **agent** = a brain + a set of tools with an **internal feedback loop**. The composite runs the brain, passes `text`/`thinking` straight through the instant they're emitted, routes each `tool` block to the matching tool Actor, and feeds the resulting `tool_result` **both** back into the brain's input (so it can react) **and** out to the agent's output. (`actor-core.ts:agentActor`.)

```
                       ┌──────────────────────────────────────────────┐
   user input          │            AGENT  (composite Actor)           │         output blocks
   BlockStream ───────►│                                               │────────► BlockStream
   (text/audio/…)      │     ┌───────────────────────────────────┐     │   (text/audio/draw/
                       │     │   BRAIN (leaf Actor: the LLM)       │     │    tool/tool_result/…)
                       │     │   emits text│thinking│tool blocks   │     │
                       │     └──────┬───────────────────▲──────────┘     │
                       │   tool block│           tool_result             │
                       │            ▼            (fed back IN)           │
                       │     ┌──────────────┐  ─────────┘               │
                       │     │ route by Name│                            │
                       │     └───┬────┬─────┘                            │
                       │  ┌──────▼─┐ ┌▼────────────┐                     │
                       │  │ TOOL   │ │ SUB-AGENT   │  ← another Actor,    │
                       │  │ Actor  │ │ Actor       │    wired exactly     │
                       │  └────────┘ └─────────────┘    like a tool       │
                       └───────────────────────────────────────────────┘
                                              │
                            output stream fans to CHANNEL-Actors, each rendering by Kind:
              ┌───────────────────────┬───────────────────────┬───────────────────────┐
              ▼                       ▼                       ▼
        ┌───────────┐           ┌───────────┐           ┌───────────┐
        │  VOICE    │           │   TEXT    │           │ WHITEBOARD│
        │ Actor     │           │  Actor    │           │  Actor    │
        │ renders   │           │ renders   │           │ renders   │
        │ {text→TTS,│           │ {text}    │           │ {draw}    │
        │  audio}   │           │           │           │           │
        │ clock=    │           │ clock=    │           │ clock=    │
        │ audio dur.│           │ typewriter│           │ paint     │
        └───────────┘           └───────────┘           └───────────┘
```

A **channel is just a human-facing Actor** that renders by `Kind` (text → screen, `text`→TTS→audio, `draw`→canvas) and may emit user input back upstream as blocks. Rendering is *wiring a channel-Actor to the output*; nothing more.

### 2.3 Delegation = one Actor calling another

This is the key unification, and it's what resolves the old §A/§B debate this doc used to host ("delegation happens at different points in different topologies"). It doesn't. **Every delegation path is the same act: an Actor routing a `tool` block to another Actor.** Concretely, the three things that *looked* different in the live system —

- the Loop's `nextStep === 'Sub-Agent'`,
- the realtime `delegate_to_agent` tool (`RealtimeChannelEngine.ts:routeToolCall`),
- the `taskGraph` / `TaskOrchestrator` fan-out,

— are all **one Actor passing a `tool` block to another Actor and feeding the `tool_result` back in.** They already funnel through `AgentRunner.RunAgent` in the live code; the Actor model is *the name for why that's the same operation*. In the proof, the sub-agent is wired into the tools map and is byte-for-byte the same shape as a tool (`actor-core.test.ts:41` `subAgent`, registered as `helper` at `:75`). Delegation stops being a topology and becomes a function call.

### 2.4 The JSON envelope evaporates (additively)

For a **block-native** agent, the JSON `LoopAgentResponse` envelope disappears: the brain emits `text` / `tool` / `thinking` blocks directly, so there's no `message` field to extract and no JSON to crack open at a channel boundary (this is the format-as-`Kind` consequence — see `channels-minimal-core.md` §2 for the full aesthetic treatment; not repeated here).

This is **additive, not a teardown.** The existing JSON Loop agent becomes **one legacy Actor** that adapts JSON→blocks: it runs exactly as today, parses its own envelope, and emits blocks on the way out. Block-native agents and the legacy JSON-adapter Actor **coexist** behind the same `(input) => output` signature. Nobody has to migrate to land the model.

> For the smallest-shape derivation, the `format = Kind` principle, and the lineage (earendil-works/pi, MJ's own `AgentEventStream`), see **[`channels-minimal-core.md`](./channels-minimal-core.md)**. This doc deliberately does not duplicate it.

---

## 3. Per-Actor speed — the requirement, now framed as a per-Actor clock

"Speed" is the requirement that breaks the naive design. Under the Actor model it has a precise home: **each consuming Actor renders at its own clock.** Walk the three candidate models:

- **"Each channel re-generates the answer."** Rejected. Two channels would produce *different* answers (nondeterminism), double the cost, and there'd be no shared transcript. The agent (one composite Actor) must run **once**.
- **"One shared render clock drives all channels."** Rejected. Audio is bounded by *speaking duration* — you cannot play 8 seconds of speech in 2. Text has no such bound. A single clock forces text to crawl at audio rate or makes audio impossible. The clocks are physically independent.
- **"One output stream, N consuming Actors, each with its own clock."** The only model that survives — and it's exactly what the Actor model gives you for free: the agent emits one `BlockStream`; each channel-Actor consumes it at its own pace.

A channel-Actor is therefore **a consumer with its own clock, not a fixed-rate pipe.**

### Consequence (i): sync policy is per-Actor

Voice plays at audio rate; text may **lead** (show the whole answer instantly), **lag**, **typewriter** (match speaking), or **sync-to-voice** (highlight the spoken word). These are per-Actor policy choices. The architecture must not bake one in. **[DESIGNED]** — today there is no formal "SyncPolicy" object; the *capability* (independent clocks) exists, the *policy knob* does not. In the Actor model the clock lives inside each channel-Actor's render loop — exactly where it belongs.

### Consequence (ii): the brain choice constrains the headroom

The clock a consuming Actor *can* run at is bounded by which **brain** (leaf Actor) produced the stream:

- **Realtime S2S** (`RealtimeChannelEngine.ts:wireSession`) — the brain emits **audio and its own transcription together**, at **speech rate**. `session.OnTranscript(...)` fires `assistant-text`; `session.OnAudio(...)` fires audio frames. The clock is speech-paced — that's the ceiling.
- **Cascaded** (`CascadedChannelEngine.ts:runAgent`) — the LLM brain emits **text first** (LLM-paced, can be fast); voice TTS-es it (audio-bound, slower to first sound) while text *could* display as fast as tokens arrive.

Same substance as before: the block stream is precisely what **normalizes these two different brains** into the same `text` / `audio` block shape every consuming Actor sees. That normalization *is* the argument for blocks being the unit — without it, voice and text need engine-specific glue per consumer. You can watch the two clocks diverge in the live widget today (`voice-widget.component.ts`):

```
onTranscriptEvent():   case 'voice-realtime' assistant-text → type-in-place (render NOW)
                       case 'voice-cascaded' assistant-text → SUPPRESSED (wait for agent-response)
onAudioFrame():        decode PCM → schedule at max(currentTime, nextStartTime)
                                  → nextStartTime += buffer.duration   (gapless, audio-bound clock)
```

Two subscriptions, two clocks: `transcriptSubscription` paints text, `audioSubscription` schedules audio against its own `nextStartTime` cursor, wired and torn down independently (`voice-widget.component.ts:220-221`, `:975-981`). The realtime-vs-cascaded branch at `:783` is the per-brain-clock difference made concrete. Under the Actor model these two ad-hoc subscriptions become **two channel-Actors with two clocks** — the same picture, named.

---

## 4. The proof — `actor-core.ts` + `actor-core.test.ts` (5/5 green)

The recommended model is not a sketch. It's a standalone artifact with a passing test that demonstrates every load-bearing claim of §2. **[PROVEN-CORE]** — and be precise: this is a **standalone core with a green test, NOT wired into the live engines, widget, or `ChannelSession`.** It proves the *shape* is real; it does not prove the plumbing is done.

The core (`packages/AI/AgentChannelRuntime/src/actor-core.ts`): `Block` union, dual `BlockStream`, the `Actor` type, `streamOf` / `collect` helpers, an async push-`BlockQueue` (what lets the brain's input stay open so `tool_result`s feed back in after the brain has already started emitting), and `agentActor` (the composite).

The proof (`packages/AI/AgentChannelRuntime/src/__tests__/actor-core.test.ts`, **5/5 green**) asserts exactly the §2 claims, no more:

| Test (`actor-core.test.ts`) | What it proves |
|---|---|
| `delegation = Actor calling Actor` (`:78`) | a `tool` block routes to a tool Actor; the `tool_result` flows back into the agent output. §2.3. |
| `talk-while-delegating` (`:87`) | filler `text` is emitted **before** the `tool_result` — the brain never stalls on the tool (the `BlockQueue` keeps the brain's input live). §2.2 composite loop. |
| `final answer incorporates the result` (`:96`) | "the answer is 4." comes **after** the `tool_result` fed back into the brain. The feedback loop is real, not cosmetic. |
| `channels render by Kind` (`:103`) | a Text channel-Actor collects exactly the 3 `text` blocks, ignoring `tool`/`tool_result`. §2.2 "channel = render-by-`Kind`." |
| `dual stream/result` (`:114`) | `streamOf([...]).result()` returns the full array; the same object is `for await`-able. §2.1 dual `BlockStream`. |

The `subAgent` in the test (`:41`) is wired into the tools map identically to the `calc` tool (`:75`) — that *is* the demonstration that delegation = Actor calling Actor, with zero special-casing. **Standalone, green, not yet live.**

---

## 5. The gap between the proven core and the live system (the rewrite surface)

This is the load-bearing honesty in the doc. The §4 core is proven; the **live system does not run on it yet**. Here is the precise delta — i.e., the surface a rewrite would touch. Every item is still true.

```
   LIVE TODAY                                  WHERE THE ACTOR MODEL LANDS IT
   ──────────                                  ──────────────────────────────
   ChannelSession → ONE engine                 ChannelSession → one composite Actor (agent)
     (DriverClass, single bind)                  emitting one BlockStream, N channel-Actors attach
   AgentStreamEvent + ChannelTranscriptEvent   one Block union (format = Kind)
   MessageFieldExtractor digs `message`        block-native brain emits `text` blocks; extractor evaporates
   StreamToTTS off by default                  text blocks → voice channel-Actor's TTS render
   TextChatChannelEngine.Run() throws          text is just another channel-Actor
   2 pubsub topics + 2 client subscriptions    2 channel-Actors with 2 clocks (formalized)
   WebRTC mic-in skeleton                      (unchanged; transport, orthogonal to the model)
```

Itemized, with citations:

- **Single engine per session.** `ChannelSession` binds to **exactly one engine**: it reads `channel.DriverClass` and does one `ClassFactory.CreateInstance<BaseChannelEngine>(BaseChannelEngine, channel.DriverClass)` (`ChannelSession.ts:355`), stores it as `currentEngine`, runs it. One session = one channel = one engine. The Actor model wants one composite Actor + N attached channel-Actors. **This is the central gap, not a detail.**
- **Multi-channel is emergent, not formalized.** The demo's voice+text simultaneity is **one** `voice-*` session whose **single** engine emits a stream the **widget** happens to render on two clocks (text pane + audio playback), draining two pubsub topics (`ChannelSessionResolver.ts:ChannelTranscript`, `:ChannelAudioOut`). It *gestures* at "N consuming Actors" but there is no server-side notion of "two channels attached to one session," no rate/sync object. Happy consequence, not a designed primitive.
- **Two coexisting streams.** `AgentStreamEvent` (`agent-stream-events.ts:AgentStreamEvent`, the token substrate) **and** `ChannelTranscriptEvent` (`transcript-event.ts:ChannelTranscriptEvent`, the UI block union) both exist. The Actor model collapses to one `Block` union. Until the rewire, the live system has two.
- **`StreamToTTS` defaults OFF.** The token-level concurrent-TTS path exists but is gated, because multi-step loop agents emit a `message` per step (`channel-config.ts:VoiceCascadedConfig.StreamToTTS`, long comment at `CascadedChannelEngine.ts:347`). So the proven *live* demo path is still "run fully, then speak" — cascaded voice's time-to-first-audio is bounded by the whole run; the per-Actor-speed story is strongest for *realtime*, weaker for *cascaded* today.
- **`MessageFieldExtractor`.** Today a `MessageFieldExtractor` digs the `message` field out of streaming JSON mid-flight so voice speaks prose, not a JSON blob. Under block-native agents it has no job (§2.4). Until the rewire, it's load-bearing.
- **`TextChatChannelEngine.Run()` throws** (`TextChatChannelEngine.ts:29`) — text-chat is *declared* as a channel but not *driven* as one through `ChannelSession`; real text orchestration lives on the existing chat path. In the Actor model text is just a channel-Actor.
- **WebRTC mic-in is skeleton.** `WebRTCTransport.Open()` throws; full-duplex voice rides the text-in/voice-out transport for the demo (`ChannelSessionResolver.ts` KNOWN LIMITATION). This is transport, orthogonal to the model — listed for completeness.

The encouraging part: the cascaded engine's `runAgent` already emits a normalized `AgentStreamEvent` (`CascadedChannelEngine.ts:runAgent`) — that's the seam where a brain-Actor adapter slots in. The rewrite is mostly *naming and wiring*, not new transport machinery.

---

## 6. The one-vs-three question — now: **Actor is the one primitive; capability + surface are roles**

This used to be an open vote ("one Channel primitive, or three: capability / stream / surface?"). **We now have a recommendation.** But it's still a decision-doc section — here's the recommendation, then the honest counter-case the room can push on.

### The recommendation

The three things a "Channel" conflates —

- **(a) Capability declaration** — *what an agent supports* (`AIAgentChannel` + `AIAgentChannelConfig`),
- **(b) Stream / transport** — *the typed block stream + the wire*,
- **(c) Renderer / surface** — *the consumer with its own clock*,

— are **not three primitives. They are three roles a single primitive plays.** The **Actor** is the one primitive:

```
   the ONE primitive:   Actor = (BlockStream) => BlockStream
                         carries blocks (role b — stream is intrinsic to the type)
                         │
   ┌─────────────────────┼──────────────────────────────────┐
   │                                                          │
 capability (role a)                                     surface (role c)
 = METADATA declaring                                    = a human-facing Actor
   which Actors an agent offers                            (renders by Kind, may emit input)
   (AIAgentChannel / AIAgentChannelConfig                  e.g. voice-widget, whiteboard
    rows still describe "agent X offers Actor Y")
```

- **Stream** isn't a separate primitive — it's *intrinsic* to the Actor type (`(BlockStream) => BlockStream`). Every Actor carries blocks by definition.
- **Capability** is **metadata** that declares *which Actors an agent offers* (voice, text, whiteboard). The existing `AIAgentChannel` / `AIAgentChannelConfig` rows are exactly this declaration; they keep their job (§4.1 below).
- **Surface** is just a **channel-Actor** — a human-facing Actor that renders by `Kind` and emits user input back. Not a new noun; a role.

So "the three" collapse to **roles an Actor plays**, unified by one signature. This is the recommendation: **adopt the Actor as THE primitive and rewrite around it.**

### The honest counter-case (when you might still want explicit separate primitives)

The room should be able to push back. The case for keeping capability/surface as *distinct, first-class primitives* (rather than "roles of an Actor") is real:

- **Metadata wants a schema, not a function signature.** "Capability" lives in the database (`AIAgentChannel.DriverClass`, config JSON). A function type can't be a table row. If the declared-capability surface needs rich, queryable, validated metadata (latency budgets, voice profiles, per-channel config discriminators — which already exist), forcing it to be "just metadata about an Actor" may under-model it. The discriminated `ChannelKind` union (`channel-config.ts:ChannelKind`) is doing real type-safety work today that a bare `Actor` doesn't capture.
- **Surfaces have lifecycle the Actor type doesn't express.** Attach/detach, sync policy, clock, transport binding, teardown — a surface is more than `(in) => out`. If we routinely run 3+ simultaneous surfaces with independent policies, a first-class `Surface { clock, syncPolicy, transport }` object may earn its place rather than being smuggled inside a channel-Actor's closure.
- **Over-abstraction risk.** If the product reality is "almost always one or two surfaces, mostly voice+text," collapsing everything to "Actor" is elegant but may buy little over the simpler "Channel = capability + engine + renderer, bundled" we already have — at the cost of a rewrite.

**Honest read:** the Actor unification is the right *mental model* and the proof (§4) shows it's real and small. The genuine question for the room is whether **capability** (a DB-backed schema) and **surface** (a lifecycle-bearing renderer) are *fully* expressible as "roles of an Actor + metadata," or whether one or both deserves to stay a first-class primitive with its own schema/lifecycle. The proof covers the *runtime* unification cleanly; it does **not** prove the *metadata/lifecycle* side collapses as neatly. That's the part still genuinely open. Recommendation stands; ratification is the room's.

---

## 7. How capability is plumbed TODAY (grounded, cited)

The Actor model keeps the existing capability-declaration metadata — it's role (a) above, unchanged. For grounding:

- **`AIAgentChannel`** declares a channel: `Name` + `DriverClass` + `DefaultConfigJSON`. `DriverClass` is *"the @RegisterClass key for the BaseChannelEngine implementation that drives this channel (e.g., CascadedChannelEngine, RealtimeChannelEngine, TextChatChannelEngine)"* (verbatim, `entity_subclasses.ts:1168`).
- **`AIAgentChannelConfig`** is the per-agent join: *"Join table between AIAgent and AIAgentChannel. Captures which channels an agent supports, their preferred ordering, per-agent JSON overrides, optional voice profile, and latency budget."* (verbatim, `entity_subclasses.ts:30434`). This row IS "agent X offers Actor Y."
- `ChannelSession.Run()` (`ChannelSession.ts:215`) loads `AIAgent` → `AIAgentChannel` by name → `AIAgentChannelConfig` → `MergeChannelConfig(defaults ⊕ per-agent ⊕ caller)` (`ChannelSession.ts:138`), validated against the `ChannelKind` discriminator (`channel-config.ts:ChannelKind`: `text-chat` | `voice-cascaded` | `voice-realtime` | `phone` | `video-realtime`).

The live engines (each a candidate brain-/composite-Actor under the rewrite): `CascadedChannelEngine` **[PROTOTYPE]** (STT→BaseAgent→TTS), `RealtimeChannelEngine` **[PROTOTYPE]** (bidirectional S2S; its native `delegate_to_agent` / `draw_on_whiteboard` tools — `RealtimeChannelEngine.ts:routeToolCall` — are already "Actor calling Actor" in spirit), `TextChatChannelEngine` **[PROTOTYPE/stub]** (`Run()` throws, `:29`).

---

## 8. Future channels slotting in (extensibility evidence)

The whiteboard is the proof the abstraction generalizes — it was added as a **new channel-Actor WITHOUT changing the stream or session core**:

- A new block kind `draw` on the union (`actor-core.ts:Block` / live `transcript-event.ts:DrawOpBlockEvent`), riding the same output path as `tool` blocks.
- A new tool `draw_on_whiteboard` the realtime brain calls (`RealtimeChannelEngine.ts:DRAW_ON_WHITEBOARD_TOOL`), fanning ops out as `draw` blocks.
- A new channel-Actor — a Fabric.js canvas (`whiteboard-channel.component.ts:ApplyDrawOp`) — consuming those blocks at paint rate, independent of voice/text clocks.

No change to `ChannelSession`, no change to the stream shape, no new transport. Under the Actor model this reads cleanly: **new channel = new `Block.Kind` + new channel-Actor.** The same slot exists for **Video** **[SPECULATIVE]** (`VideoRealtimeConfig` placeholder keeps the union closed, `channel-config.ts:VideoRealtimeConfig`), **Phone** **[DESIGNED/partial]** (`PhoneConfig`, reuses the cascaded brain-Actor), and **Holograms** **[SPECULATIVE]** (the CTO's north star → "another `Block.Kind` (spatial/mesh ops) + another channel-Actor"). If holograms are *clearly* expressible that way, the model is validated; if not, that's the signal the unification leaks — and a §6 push-back point.

---

## 9. Recommendation + decisions to make in the meeting

### Recommendation

**Adopt the Actor as THE primitive and rewrite the live system around it.** The model is small (3 nouns), proven as a core (§4, 5/5 green), and it *names* what the live code already gropes toward: delegation = Actor calling Actor, channels = render-by-`Kind`, per-Actor clocks. Capability stays as metadata (role a); surface is a channel-Actor (role c); the JSON Loop agent survives as one legacy adapter Actor (§2.4) — additive, no forced migration. Sequence the live rewire deliberately (decision (d)); don't block the demo on it.

The one place to stay honest: the runtime unification is proven; the **metadata/lifecycle** side of "capability + surface are merely roles" is the part the proof does *not* cover (§6 counter-case). Ratify the runtime model; leave room to keep capability and/or surface first-class if the schema/lifecycle pressure is real.

### Decisions to make in the meeting

1. **Adopt Actor as THE primitive and rewrite around it?** (§2, §6) — the headline. One primitive; capability = metadata, surface = a channel-Actor. Ratify the runtime unification; decide how far the metadata/lifecycle collapse goes.
2. **Where does structured state / payload live?** (§2.4, §6 counter-case) — the one honest fork. Does structured state ride as a **state block / in the history** (everything is blocks, purely), or do we keep an **explicit payload** channel alongside the blocks? This is the genuinely-open design question; the proof is agnostic to it.
3. **Block-native agent type alongside the JSON Loop agent — yes?** (§2.4) — stand up a block-native agent that emits `text`/`tool` blocks directly, with the existing JSON Loop agent kept as a legacy adapter Actor. Coexist?
4. **Sequencing: live rewire now, or post-meeting (≈2-day wrap)?** (§5) — do the `ChannelSession` 1→N rewire + stream-collapse this cycle, or ship the emergent two-subscription demo and rewire right after?
5. **Keep or retire the second stream + `MessageFieldExtractor`?** (§5) — collapse `AgentStreamEvent` + `ChannelTranscriptEvent` to one `Block` union and delete the extractor (its job evaporates under block-native agents), or keep the two-layer split for now?
