# Whiteboard Channel — Implementation Contract (FROZEN)

Goal: an interactive whiteboard as a **parallel channel** alongside voice + text. The agent
draws on it AND sees what the student draws. Demo target: tutoring (e.g. "draw a right
triangle, label the sides", student tries, agent comments).

Everything rides the **existing GraphQL-PubSub-per-SessionID rails** — no new transport infra.
This doc is the frozen contract: every worker builds against the exact shapes below.

---

## 1. The `DrawOp` shape (the spine — identical on server + client)

Coordinates are **normalized 0..1** (origin top-left) so canvas size is irrelevant.
`Color` is a CSS color string (hex ok — agent-drawn content is a legit hardcoded-color
exception, like chart colors). `Width` / `FontSize` are pixels at render time.

```ts
type DrawOp =
  | { Type: 'stroke'; Points: { X: number; Y: number }[]; Color: string; Width: number }
  | { Type: 'shape'; Shape: 'line' | 'rect' | 'ellipse' | 'triangle' | 'arrow';
      X: number; Y: number; W: number; H: number; Color: string; Width: number }
  | { Type: 'text'; X: number; Y: number; Text: string; Color: string; FontSize: number }
  | { Type: 'clear' };
```

## 2. Outbound — agent draws (rides `ChannelTranscript`)

New transcript-event union member (runtime `transcript-event.ts`):
```ts
interface DrawOpBlockEvent {
  Kind: 'draw-op';
  OpID: string;          // dedupe / ordering
  Source: 'agent';       // outbound is always agent (student renders locally)
  Op: DrawOp;
}
```
- Engine emits these via `ctx.OnTranscript?.({...})` (same path as `ToolCallBlockEvent`).
- Resolver `ChannelTranscriptEventDTO` + `ChannelTranscriptPayload` + `publishTranscriptEvent`
  gain ONE field: `DrawOp` (GraphQL `GraphQLJSONObject`, nullable) carrying the whole `DrawOp`
  + `OpID`/`Source`. Marshal when `event.Kind === 'draw-op'`.
- Client `VoiceTranscriptEvent.Kind` gains `'draw-op'`; add optional `DrawOp?: VoiceDrawOp` field.
  `onTranscriptEvent` routes `case 'draw-op'` → `whiteboard.ApplyDrawOp(event.DrawOp)`.

## 3. Inbound — agent sees student (canvas snapshot, NOT per-stroke)

- New control event (runtime `frame-bus.ts` `ControlEvent` union):
  `| { Kind: 'user-canvas-snapshot'; ImageBase64: string; MediaType: string }`
- `TextInputAudioOutputTransport.PushCanvasSnapshot(imageBase64, mediaType)` → `controlIn.Push(...)`
  (mirror `PushUserText`, lines 126–131).
- `RealtimeChannelEngine.consumeControlEvents` gains a branch:
  `if (control.Kind === 'user-canvas-snapshot') session.SendImage(control.ImageBase64, control.MediaType);`
- Resolver: `SubmitChannelCanvasSnapshot` mutation (mirror `SubmitChannelTextTurn`, lines 526–554):
  input `{ SessionID, ImageBase64, MediaType }` → `registry.Get(SessionID)` → guard
  `TextInputAudioOutputTransport` → `transport.PushCanvasSnapshot(...)`.

## 4. Agent tool — `draw_on_whiteboard`

In `RealtimeChannelEngine` (mirror `DELEGATE_TOOL`, lines 48–68; add to `Tools:[...]` at ~line 320):
```ts
const DRAW_ON_WHITEBOARD_TOOL: ToolDefinition = {
  Name: 'draw_on_whiteboard',
  Description: 'Draw on the shared whiteboard the student is looking at. Use for diagrams, ' +
    'shapes, labels, and worked examples while you teach. Coordinates are 0..1 (top-left origin).',
  ParametersSchema: { type: 'object', properties: { ops: { type: 'array', items: { /* DrawOp */ } } },
    required: ['ops'] },
};
```
- `routeToolCall` branch `case 'draw_on_whiteboard'`: emit one `DrawOpBlockEvent` per op (fresh
  `OpID`, `Source:'agent'`), then return `{ CallID, Result: 'drawn' }`. No running/complete block
  pair needed (drawing is instant) — but DO emit a single `tool-call` block too so the text
  channel shows "✏️ drew on whiteboard" for visibility. (Nice-to-have; skip if time-pressed.)

## 5. Driver contract — `SendImage` (the P3 risk)

Add to `RealtimeSpeechSession` interface (`baseRealtimeSpeech.ts`):
```ts
/** Send a still image into the live session as user input (e.g. a whiteboard snapshot). */
SendImage(imageBase64: string, mediaType: string): void;
```
- **Gemini** (`geminiLive.ts`): `this.session.sendClientContent({ turns: [{ role: 'user',
  parts: [{ inlineData: { mimeType: mediaType, data: imageBase64 } }] }], turnComplete: true })`.
  VERIFY against `@google/genai@1.40.0`; if the shape differs, adapt. This is the riskiest call.
- **OpenAI** (`realtime.ts`): `conversation.item.create` with content `[{ type:'input_image',
  image_url: 'data:'+mediaType+';base64,'+imageBase64 }]` then `response.create`. VERIFY.
- If a provider can't accept images cleanly by Sat night: implement `SendImage` as a **no-op +
  LogStatus** so the build stays green and the agent-draws path still demos. Report the limitation.

## 6. Whiteboard component API (`<mj-whiteboard-channel>`, standalone, Generic pkg)

New: `voice-widget/src/lib/whiteboard-channel/whiteboard-channel.component.{ts,html,scss}`.
Pure canvas — no service dependency. Parent wires snapshot upload.
```ts
@Input() Interactive = true;            // student can draw
@Input() CanvasWidth = 0;               // 0 = fill container (ResizeObserver)
@Input() CanvasHeight = 0;
public ApplyDrawOp(op: DrawOp): void;   // render one agent op (parent calls per draw-op block)
public Clear(): void;
public CaptureSnapshotBase64(): string; // PNG base64, NO "data:" prefix
@Output() UserStrokeCompleted = new EventEmitter<DrawOp>();  // student finished a stroke
```
- Renders strokes/shapes/text/clear. Pointer events → freehand `stroke` ops, normalized.
- Generic-pkg rules: standalone, `inject()`, `@if/@for`, design tokens for chrome (canvas content
  colors exempt), PascalCase public members, NO Router.

## 7. Widget integration (`voice-widget.component` + service + types + html/scss)

- Channel-toggle chips header: `[Text] [Voice] [Whiteboard]` → `ShowTextChannel` /
  `ShowVoiceChannel` / `ShowWhiteboardChannel` booleans. Side-by-side layout: transcript | canvas.
- Add child `<mj-whiteboard-channel #whiteboard>` (in `imports:[...]`). Route `draw-op` events to it.
- On `UserStrokeCompleted`: debounce ~1.2s → `whiteboard.CaptureSnapshotBase64()` →
  `service.SubmitCanvasSnapshot(SessionID, b64, 'image/png')`.
- Service: `SubmitCanvasSnapshot(...)` mutation (mirror `SubmitTextTurn`). Transcript subscription
  GQL query gains the `DrawOp` field. Export the new component in `public-api.ts` + `LoadWhiteboardChannel()`.

## 8. Client types (`voice-widget.types.ts`)

Mirror `DrawOp` as `VoiceDrawOp` (same shape). Add `'draw-op'` to `VoiceTranscriptEvent.Kind`,
add `DrawOp?: VoiceDrawOp` + `OpID?: string` + `Source?: string`. Add `SubmitSnapshotResult { OK; ErrorMessage? }`.

---

## Build / ownership map (disjoint files → parallel-safe)

| Worker | Files | Builds |
|---|---|---|
| **W0 Contracts** | runtime `transcript-event.ts`, runtime `frames/frame-bus.ts`, core `baseRealtimeSpeech.ts`, client `voice-widget.types.ts` | core, runtime(types) |
| **W-Engine** | runtime `engines/RealtimeChannelEngine.ts` | ai-agent-channel-runtime |
| **W-Drivers** | core `geminiLive.ts`, openai `realtime.ts` (impl `SendImage`) | ai-gemini, ai-openai |
| **W-Resolver** | MJServer `ChannelSessionResolver.ts`, runtime `transports/TextInputAudioOutputTransport.ts` | mj_server |
| **W-Whiteboard** | NEW `whiteboard-channel/*` | ng-voice-widget |
| **W-WidgetIntegration** | `voice-widget.component.{ts,html,scss}`, `voice-widget.service.ts`, `public-api.ts` | ng-voice-widget |

Sequence: **W0** (contracts) → **Wave 1**: W-Engine ∥ W-Drivers ∥ W-Resolver ∥ W-Whiteboard →
**Wave 2**: W-WidgetIntegration → supervisor integrate-build → demo wiring.
ng-voice-widget workers (W-Whiteboard, W-WidgetIntegration) touch the same package → W-WidgetIntegration
runs AFTER W-Whiteboard.
