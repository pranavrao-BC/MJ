import {
    AfterViewInit,
    Component,
    ElementRef,
    EventEmitter,
    Input,
    NgZone,
    OnDestroy,
    Output,
    ViewChild,
    ViewEncapsulation,
    inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
    Canvas,
    Ellipse,
    FabricImage,
    FabricObject,
    FabricText,
    Line,
    Path,
    PencilBrush,
    Point,
    Polyline,
    Rect,
    Textbox,
    Triangle,
    loadSVGFromString,
    util,
} from 'fabric';
import type { TSimplePathData } from 'fabric';

// ---------------------------------------------------------------------------
// Local draw-op contract.
//
// Mirrors the whiteboard-channel spec EXACTLY and is kept in lockstep with the
// `VoiceDrawOp` union in `voice-widget.types.ts`. Coordinates are normalized
// 0..1 with a top-left origin so canvas size is irrelevant. `Color` is a CSS
// color string (agent-drawn content is a legit hardcoded-color exception, like
// chart colors). `Width` / `FontSize` are pixels at render time.
// ---------------------------------------------------------------------------
export type WhiteboardDrawOp =
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
    | { Type: 'image'; Src: string; X: number; Y: number; W: number; H: number }
    | { Type: 'svg'; Markup: string; X: number; Y: number; W: number; H: number }
    | { Type: 'clear' };

/** Active toolbar tool. */
type WhiteboardTool = 'pen' | 'select';

/** Fixed ink color for student freehand strokes (canvas content — exempt from token rule). */
const STUDENT_INK_COLOR = '#1f6feb';
/** Stroke width (px) for student freehand strokes. */
const STUDENT_INK_WIDTH = 3;

@Component({
    selector: 'mj-whiteboard-channel',
    standalone: true,
    imports: [CommonModule],
    templateUrl: './whiteboard-channel.component.html',
    styleUrls: ['./whiteboard-channel.component.scss'],
    encapsulation: ViewEncapsulation.Emulated,
})
export class WhiteboardChannelComponent implements AfterViewInit, OnDestroy {
    // --- Public API (unchanged signatures) ---------------------------------

    /** When true, the student can draw / select / move objects on the canvas. */
    @Input() Interactive = true;

    /** Fixed canvas width in px. 0 = fill container (tracked via ResizeObserver). */
    @Input() CanvasWidth = 0;

    /** Fixed canvas height in px. 0 = fill container (tracked via ResizeObserver). */
    @Input() CanvasHeight = 0;

    /** Emitted when the student completes a freehand stroke (normalized op). */
    @Output() UserStrokeCompleted = new EventEmitter<WhiteboardDrawOp>();

    @ViewChild('canvas', { static: true })
    private canvasRef!: ElementRef<HTMLCanvasElement>;

    /** Toolbar state — read by the template, written via the toggle buttons. */
    public ActiveTool: WhiteboardTool = 'pen';

    // --- Injected deps ------------------------------------------------------

    private readonly host = inject(ElementRef<HTMLElement>);
    private readonly ngZone = inject(NgZone);

    // --- Private state ------------------------------------------------------

    private canvas: Canvas | null = null;
    private resizeObserver: ResizeObserver | null = null;

    /** Current canvas CSS pixel dimensions. */
    private widthPx = 0;
    private heightPx = 0;

    // --- Lifecycle ----------------------------------------------------------

    public ngAfterViewInit(): void {
        // All Fabric init + event wiring runs OUTSIDE Angular so its render loop
        // and pointer churn never trigger change detection.
        this.ngZone.runOutsideAngular(() => {
            this.initFabric();
            this.observeResize();
        });
    }

    public ngOnDestroy(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.canvas?.dispose();
        this.canvas = null;
    }

    // --- Public methods (unchanged signatures) -----------------------------

    /** Render ONE op onto the canvas. Agent ops land as selectable/movable objects. */
    public ApplyDrawOp(op: WhiteboardDrawOp): void {
        const canvas = this.canvas;
        if (!canvas) {
            return;
        }
        switch (op.Type) {
            case 'stroke':
                this.applyStroke(canvas, op);
                break;
            case 'shape':
                this.applyShape(canvas, op);
                break;
            case 'text':
                this.applyText(canvas, op);
                break;
            case 'image':
                void this.applyImage(canvas, op);
                break;
            case 'svg':
                void this.applySvg(canvas, op);
                break;
            case 'clear':
                this.Clear();
                break;
        }
    }

    /** Wipe every object from the canvas. */
    public Clear(): void {
        const canvas = this.canvas;
        if (!canvas) {
            return;
        }
        canvas.clear();
        canvas.requestRenderAll();
    }

    /** PNG snapshot of the current canvas as base64, WITHOUT the `data:` URI prefix. */
    public CaptureSnapshotBase64(): string {
        const canvas = this.canvas;
        if (!canvas) {
            return '';
        }
        const dataUrl = canvas.toDataURL({ format: 'png', multiplier: 1 });
        const comma = dataUrl.indexOf(',');
        return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    }

    // --- Toolbar handlers (template-bound) ---------------------------------

    public SelectPen(): void {
        this.setTool('pen');
    }

    public SelectSelect(): void {
        this.setTool('select');
    }

    public OnClearClicked(): void {
        this.Clear();
    }

    // --- Fabric init --------------------------------------------------------

    private initFabric(): void {
        this.measure();
        const canvas = new Canvas(this.canvasRef.nativeElement, {
            selection: this.Interactive,
            width: this.widthPx,
            height: this.heightPx,
            preserveObjectStacking: true,
        });
        this.canvas = canvas;
        this.configureBrush(canvas);
        this.wirePathCreated(canvas);
        this.setTool(this.Interactive ? 'pen' : 'select');
    }

    private configureBrush(canvas: Canvas): void {
        const brush = new PencilBrush(canvas);
        brush.color = STUDENT_INK_COLOR;
        brush.width = STUDENT_INK_WIDTH;
        canvas.freeDrawingBrush = brush;
    }

    /** Apply the active tool to canvas drawing/selection modes. */
    private setTool(tool: WhiteboardTool): void {
        this.ActiveTool = tool;
        const canvas = this.canvas;
        if (!canvas) {
            return;
        }
        const drawing = this.Interactive && tool === 'pen';
        canvas.isDrawingMode = drawing;
        // In select mode objects are interactive; in pen mode they don't grab the pointer.
        canvas.selection = this.Interactive && tool === 'select';
        canvas.skipTargetFind = drawing;
        canvas.requestRenderAll();
    }

    /** Listen for finished freehand paths and emit them as normalized stroke ops. */
    private wirePathCreated(canvas: Canvas): void {
        canvas.on('path:created', (e: { path: FabricObject }) => {
            if (!this.Interactive) {
                return;
            }
            const path = e.path as Path;
            this.makeInteractive(path);
            const op = this.pathToStrokeOp(path);
            if (op) {
                // Only re-enter Angular's zone to fire the public output.
                this.ngZone.run(() => this.UserStrokeCompleted.emit(op));
            }
        });
    }

    // --- Op → Fabric mapping ------------------------------------------------

    private applyStroke(canvas: Canvas, op: Extract<WhiteboardDrawOp, { Type: 'stroke' }>): void {
        if (op.Points.length < 2) {
            return;
        }
        const points = op.Points.map((p) => new Point(p.X * this.widthPx, p.Y * this.heightPx));
        const poly = new Polyline(points, {
            stroke: op.Color,
            strokeWidth: op.Width,
            fill: '',
            strokeLineCap: 'round',
            strokeLineJoin: 'round',
            objectCaching: false,
        });
        this.makeInteractive(poly);
        canvas.add(poly);
        canvas.requestRenderAll();
    }

    private applyShape(canvas: Canvas, op: Extract<WhiteboardDrawOp, { Type: 'shape' }>): void {
        const x = op.X * this.widthPx;
        const y = op.Y * this.heightPx;
        const w = op.W * this.widthPx;
        const h = op.H * this.heightPx;
        const object = this.buildShape(op.Shape, x, y, w, h, op.Color, op.Width);
        if (!object) {
            return;
        }
        this.makeInteractive(object);
        canvas.add(object);
        canvas.requestRenderAll();
    }

    private buildShape(
        shape: Extract<WhiteboardDrawOp, { Type: 'shape' }>['Shape'],
        x: number,
        y: number,
        w: number,
        h: number,
        color: string,
        width: number,
    ): FabricObject | null {
        const stroke = { stroke: color, strokeWidth: width, fill: '' as const };
        switch (shape) {
            case 'line':
                return new Line([x, y, x + w, y + h], { stroke: color, strokeWidth: width });
            case 'rect':
                return new Rect({ left: x, top: y, width: w, height: h, ...stroke });
            case 'ellipse':
                return new Ellipse({
                    left: x,
                    top: y,
                    rx: Math.abs(w / 2),
                    ry: Math.abs(h / 2),
                    ...stroke,
                });
            case 'triangle':
                return new Triangle({ left: x, top: y, width: w, height: h, ...stroke });
            case 'arrow':
                return this.buildArrow(x, y, w, h, color, width);
        }
    }

    /** An arrow = a polyline that traces the shaft plus the two head barbs. */
    private buildArrow(x: number, y: number, w: number, h: number, color: string, width: number): FabricObject {
        const tipX = x + w;
        const tipY = y + h;
        const angle = Math.atan2(h, w);
        const headLen = Math.min(18, Math.hypot(w, h) * 0.3);
        const spread = Math.PI / 7;
        const pts = [
            new Point(x, y),
            new Point(tipX, tipY),
            new Point(tipX - headLen * Math.cos(angle - spread), tipY - headLen * Math.sin(angle - spread)),
            new Point(tipX, tipY),
            new Point(tipX - headLen * Math.cos(angle + spread), tipY - headLen * Math.sin(angle + spread)),
        ];
        return new Polyline(pts, {
            stroke: color,
            strokeWidth: width,
            fill: '',
            strokeLineCap: 'round',
            strokeLineJoin: 'round',
            objectCaching: false,
        });
    }

    private applyText(canvas: Canvas, op: Extract<WhiteboardDrawOp, { Type: 'text' }>): void {
        const text = new Textbox(op.Text, {
            left: op.X * this.widthPx,
            top: op.Y * this.heightPx,
            fontSize: op.FontSize,
            fill: op.Color,
            fontFamily: 'sans-serif',
        });
        this.makeInteractive(text);
        canvas.add(text);
        canvas.requestRenderAll();
    }

    private async applyImage(canvas: Canvas, op: Extract<WhiteboardDrawOp, { Type: 'image' }>): Promise<void> {
        const image = await FabricImage.fromURL(op.Src, { crossOrigin: 'anonymous' });
        if (this.canvas !== canvas) {
            return; // component torn down / canvas replaced while loading
        }
        this.placeInBox(image, op.X, op.Y, op.W, op.H);
        this.makeInteractive(image);
        canvas.add(image);
        canvas.requestRenderAll();
    }

    private async applySvg(canvas: Canvas, op: Extract<WhiteboardDrawOp, { Type: 'svg' }>): Promise<void> {
        const result = await loadSVGFromString(op.Markup);
        if (this.canvas !== canvas) {
            return;
        }
        const objects = result.objects.filter((o): o is FabricObject => o !== null);
        if (objects.length === 0) {
            return;
        }
        const group = util.groupSVGElements(objects, result.options);
        this.placeInBox(group, op.X, op.Y, op.W, op.H);
        this.makeInteractive(group);
        canvas.add(group);
        canvas.requestRenderAll();
    }

    /** Position + scale an object to fit the normalized (X,Y,W,H) box. */
    private placeInBox(object: FabricObject, nx: number, ny: number, nw: number, nh: number): void {
        const boxW = nw * this.widthPx;
        const boxH = nh * this.heightPx;
        const naturalW = object.width || 1;
        const naturalH = object.height || 1;
        // Fit-within scale so the whole object stays inside the box, preserving aspect.
        const scale = Math.min(boxW / naturalW, boxH / naturalH) || 1;
        object.set({
            left: nx * this.widthPx,
            top: ny * this.heightPx,
            scaleX: scale,
            scaleY: scale,
        });
        object.setCoords();
    }

    /** Agent + user objects are all manipulable when Interactive (dingboard feel). */
    private makeInteractive(object: FabricObject): void {
        const editable = this.Interactive;
        object.selectable = editable;
        object.evented = editable;
        object.hasControls = editable;
        object.hasBorders = editable;
    }

    // --- path:created → normalized stroke ----------------------------------

    /**
     * Convert a finished freehand `Path` into a normalized stroke op by reading
     * each segment's local end-point, mapping it through the path's transform
     * matrix to canvas coordinates, then normalizing by canvas size.
     */
    private pathToStrokeOp(path: Path): WhiteboardDrawOp | null {
        if (this.widthPx <= 0 || this.heightPx <= 0) {
            return null;
        }
        const matrix = path.calcTransformMatrix();
        const offset = path.pathOffset;
        const segments = path.path as TSimplePathData;
        const points: { X: number; Y: number }[] = [];
        for (const seg of segments) {
            const local = this.segmentEndPoint(seg);
            if (!local) {
                continue;
            }
            const centered = new Point(local.x - offset.x, local.y - offset.y);
            const world = util.transformPoint(centered, matrix);
            points.push({
                X: this.clamp01(world.x / this.widthPx),
                Y: this.clamp01(world.y / this.heightPx),
            });
        }
        if (points.length < 2) {
            return null;
        }
        return { Type: 'stroke', Points: points, Color: STUDENT_INK_COLOR, Width: STUDENT_INK_WIDTH };
    }

    /** Pull the end-point (last x,y pair) out of a parsed path segment command. */
    private segmentEndPoint(segment: (string | number)[]): { x: number; y: number } | null {
        // Trailing two numbers of a segment are always its end coordinate
        // (M x y / L x y / Q cx cy x y / C c1x c1y c2x c2y x y). 'Z' has none.
        const command = segment[0];
        if (command === 'Z' || command === 'z') {
            return null;
        }
        const y = segment[segment.length - 1];
        const x = segment[segment.length - 2];
        if (typeof x !== 'number' || typeof y !== 'number') {
            return null;
        }
        return { x, y };
    }

    // --- Sizing -------------------------------------------------------------

    private observeResize(): void {
        if (this.CanvasWidth > 0 && this.CanvasHeight > 0) {
            return; // fixed dimensions — no observer needed
        }
        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(this.host.nativeElement);
    }

    private onResize(): void {
        const canvas = this.canvas;
        if (!canvas) {
            return;
        }
        const prevW = this.widthPx;
        const prevH = this.heightPx;
        this.measure();
        if (this.widthPx === prevW && this.heightPx === prevH) {
            return;
        }
        canvas.setDimensions({ width: this.widthPx, height: this.heightPx });
        if (prevW > 0 && prevH > 0) {
            this.rescaleObjects(canvas, this.widthPx / prevW, this.heightPx / prevH);
        }
        canvas.requestRenderAll();
    }

    /** Proportionally reflow existing objects so content tracks the new canvas size. */
    private rescaleObjects(canvas: Canvas, sx: number, sy: number): void {
        for (const object of canvas.getObjects()) {
            object.set({
                left: (object.left ?? 0) * sx,
                top: (object.top ?? 0) * sy,
                scaleX: (object.scaleX ?? 1) * sx,
                scaleY: (object.scaleY ?? 1) * sy,
            });
            object.setCoords();
        }
    }

    private measure(): void {
        const targetW = this.CanvasWidth > 0 ? this.CanvasWidth : this.host.nativeElement.clientWidth;
        const targetH = this.CanvasHeight > 0 ? this.CanvasHeight : this.host.nativeElement.clientHeight;
        this.widthPx = Math.max(1, Math.round(targetW));
        this.heightPx = Math.max(1, Math.round(targetH));
    }

    // --- Helpers ------------------------------------------------------------

    private clamp01(value: number): number {
        return Math.min(1, Math.max(0, value));
    }
}

/** Tree-shake prevention stub — widget integration calls this from public-api. */
export function LoadWhiteboardChannel(): void {}
