# Whiteboard → True Multi-Channel: Streaming Strokes + Signal Fusion (Vision)

Status: **vision / roadmap** (not frozen). The shipped whiteboard (see
[`whiteboard-channel-spec.md`](whiteboard-channel-spec.md)) is the v1 baseline; this doc
captures the next target raised by Amith and how it maps onto the
[Block/Actor model](channels-minimal-core.md) and
[architecture position](channels-architecture-position.md).

---

## What we have today (v1)

- The agent draws by emitting **one finished `draw-op`** (currently a full-canvas SVG) over
  `ChannelTranscript`. The board renders it **all at once** when the tool call completes.
- The student draws freehand; completed strokes are snapshotted (`SubmitChannelCanvasSnapshot`)
  and sent to the model as a **separate** image turn.
- Voice / text / whiteboard are parallel channels, but the signals are **loosely coupled** —
  the model sees the board image and the text, but not *fused* as one intent.

This proves the plumbing. It is **not yet** a real whiteboard feel.

## The target (v2) — a facsimile of a real whiteboard

Two distinct upgrades, both in service of "this is genuinely multi-channel":

### A. Stream the drawing as it's "thought" — a marker, not a paste

The agent should appear to **draw stroke-by-stroke, low-latency, while still incomplete** —
like a tutor at a whiteboard — rather than pasting a finished figure. Lower perceived latency,
and the student sees the reasoning take shape.

Two ways to get there (likely both, layered):

1. **Client-side progressive render (pragmatic, ship-first).** The model still declares
   *intent* ("draw a labeled right triangle"), but the engine/client renders that intent as a
   **timed sequence of stroke ops** — a "drawing Actor" that animates the marker along each
   path over ~0.5–1.5s instead of `add()`-ing the whole group instantly. No dependence on the
   model's tool-call cadence; instant low-latency feel. The `DrawOp.stroke` (array of points)
   primitive already supports this — we emit partial strokes on a timer.
2. **Model-streamed geometry (richer, later).** The model emits a **sequence** of small
   draw-ops (stroke / shape / text), each rendered as it arrives, so the *content* itself
   streams. Bounded by how fast the realtime model will emit successive tool calls; best for
   genuinely incremental diagrams where order conveys meaning.

Recommendation: build (1) now (it's the visible win and is deterministic), keep (2) as the
path for content that must stream semantically.

### B. Fuse all channels into one intent — including deixis ("this")

The headline scenario: the student **circles part of the drawing and says "tell me more about
*this*"** — and the agent knows what "this" is. That requires the agent's input for a turn to
be a **single fused multimodal signal**, not three disconnected ones:

- **Board state** — current canvas snapshot (already streamed).
- **Deictic gesture** — the student's pointer/markup *with coordinates* (a `draw-op` from the
  student carrying `{X,Y}` / a region), sent **live**, not just at turn end.
- **Speech/text** — the spoken or typed words, time-aligned with the gesture.

The fix: when the student gestures + speaks, send the model **one turn** = the snapshot (ideally
annotated with where they pointed) **+** the text **+** a note like "the user is pointing at
(0.62, 0.40)". `gpt-realtime` accepts image+text in a turn, so this is reachable now. The
student's strokes also need to flow **inbound** as `draw-op`s (today only the agent's are a
first-class block; the student's are snapshot-only).

## Why this is the multi-channel proof

This is exactly where the **Block/Actor** model earns its place (and answers "what can't the
alternatives do"):

- Each channel is an **input Actor** producing typed blocks — `audio`, `text`, `draw`,
  `pointer` — that **merge into one agent input stream**. The agent's output blocks (`draw`,
  `audio`, `text`) **fan back out** to the surfaces, each at its own rate.
- Deixis resolution ("this") is just **time-aligned blocks from different channels arriving on
  one stream** — the agent sees the pointer block and the text block together. Without a unified
  block stream you hand-wire every cross-channel correlation; with it, fusion is the default.
- Streaming strokes = the agent's `draw` blocks arriving and rendering **incrementally** with
  backpressure — the same property that gives talk-while-working and barge-in.

So the v2 whiteboard isn't a whiteboard feature — it's the **first real test of the
multi-channel concept**: concurrent bidirectional channels feeding and draining one agent
context.

## Work breakdown (rough, dependency-ordered)

1. **Inbound student draw-ops as blocks** — student strokes flow over the session as `draw-op`
   blocks with coordinates (not just snapshots). [runtime + resolver + widget]
2. **Fused turn** — bundle snapshot + pointer coords + text into one multimodal model turn;
   annotate the snapshot with the gesture location. [realtime engine + drivers]
3. **Progressive render Actor (A.1)** — animate agent draw intent stroke-by-stroke client-side.
   [voice-widget]
4. **Model-streamed geometry (A.2)** — encourage/aggregate successive small draw-ops. [engine +
   prompt]
5. **Pointer/markup tool for the student** — a lightweight "point here" gesture distinct from
   freehand ink. [widget]

Items 1–3 are the demo-meaningful core; 4–5 are refinements.

## Open questions for the architecture call

- Do inbound channel signals merge on the existing `AgentEventStream`, or a new block stream?
  (Ties to the "one stream primitive vs two" decision — see architecture-position doc.)
- Where does the Actor composition layer live so the **agent runtime** can consume fused input
  Actors without depending on the channels package? (Relocation out of the channels leaf.)
- Latency budget for "this"-style deixis: how fast must gesture+speech fuse to feel natural?
