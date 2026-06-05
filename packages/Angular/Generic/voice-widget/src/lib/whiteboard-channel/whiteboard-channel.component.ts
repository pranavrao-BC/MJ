import {
    AfterViewInit,
    Component,
    ElementRef,
    EventEmitter,
    Input,
    OnDestroy,
    Output,
    ViewChild,
    ViewEncapsulation,
    inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';

// ---------------------------------------------------------------------------
// Local draw-op contract.
//
// Mirrors §1 of the whiteboard-channel spec EXACTLY. Kept local (rather than
// imported) so this component carries no cross-file dependency — the parent
// widget passes structurally-compatible objects. Coordinates are normalized
// 0..1 with a top-left origin so the canvas size is irrelevant. `Color` is a
// CSS color string (agent-drawn content is a legit hardcoded-color exception,
// like chart colors). `Width` / `FontSize` are pixels at render time.
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
    | { Type: 'clear' };

/** Fixed ink color for student freehand strokes (canvas content — exempt from token rule). */
const STUDENT_INK_COLOR = '#1f6feb';
/** Stroke width (px) for student freehand strokes. */
const STUDENT_INK_WIDTH = 3;
/** Minimum pointer movement (normalized) before a new point is recorded — keeps stroke arrays tidy. */
const MIN_POINT_DELTA = 0.002;

@Component({
    selector: 'mj-whiteboard-channel',
    standalone: true,
    imports: [CommonModule],
    templateUrl: './whiteboard-channel.component.html',
    styleUrls: ['./whiteboard-channel.component.scss'],
    encapsulation: ViewEncapsulation.Emulated,
})
export class WhiteboardChannelComponent implements AfterViewInit, OnDestroy {
    // --- Public API (spec §6) ----------------------------------------------

    /** When true, the student can draw freehand strokes on the canvas. */
    @Input() Interactive = true;

    /** Fixed canvas width in px. 0 = fill container (tracked via ResizeObserver). */
    @Input() CanvasWidth = 0;

    /** Fixed canvas height in px. 0 = fill container (tracked via ResizeObserver). */
    @Input() CanvasHeight = 0;

    /** Emitted when the student completes a freehand stroke (normalized op). */
    @Output() UserStrokeCompleted = new EventEmitter<WhiteboardDrawOp>();

    @ViewChild('canvas', { static: true })
    private canvasRef!: ElementRef<HTMLCanvasElement>;

    // --- Private state ------------------------------------------------------

    private readonly host = inject(ElementRef<HTMLElement>);

    /** Backing store of every applied op, replayed on resize. */
    private ops: WhiteboardDrawOp[] = [];

    /** In-progress freehand stroke (normalized points), null when not drawing. */
    private activeStroke: { X: number; Y: number }[] | null = null;

    /** Pointer id captured during the active stroke, for pointer-capture release. */
    private activePointerId: number | null = null;

    private resizeObserver: ResizeObserver | null = null;

    /** Current canvas pixel dimensions (after DPR scaling is applied to the backing store). */
    private cssWidth = 0;
    private cssHeight = 0;

    // --- Lifecycle ----------------------------------------------------------

    public ngAfterViewInit(): void {
        this.syncCanvasSize();
        if (this.CanvasWidth === 0 || this.CanvasHeight === 0) {
            this.resizeObserver = new ResizeObserver(() => this.onContainerResize());
            this.resizeObserver.observe(this.host.nativeElement);
        }
        this.redrawAll();
    }

    public ngOnDestroy(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
    }

    // --- Public methods (spec §6) ------------------------------------------

    /** Render ONE agent op and persist it in the backing store. */
    public ApplyDrawOp(op: WhiteboardDrawOp): void {
        if (op.Type === 'clear') {
            this.Clear();
            return;
        }
        this.ops.push(op);
        const ctx = this.getContext();
        if (ctx) {
            this.renderOp(ctx, op);
        }
    }

    /** Wipe the canvas and reset the op store. */
    public Clear(): void {
        this.ops = [];
        const ctx = this.getContext();
        if (ctx) {
            ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
        }
    }

    /** PNG snapshot of the current canvas as base64, WITHOUT the `data:` URI prefix. */
    public CaptureSnapshotBase64(): string {
        const dataUrl = this.canvasRef.nativeElement.toDataURL('image/png');
        const comma = dataUrl.indexOf(',');
        return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    }

    // --- Pointer handlers (template-bound) ---------------------------------

    public OnPointerDown(event: PointerEvent): void {
        if (!this.Interactive) {
            return;
        }
        const point = this.toNormalized(event);
        this.activeStroke = [point];
        this.activePointerId = event.pointerId;
        this.canvasRef.nativeElement.setPointerCapture(event.pointerId);
        event.preventDefault();
    }

    public OnPointerMove(event: PointerEvent): void {
        if (!this.Interactive || this.activeStroke === null) {
            return;
        }
        const point = this.toNormalized(event);
        const last = this.activeStroke[this.activeStroke.length - 1];
        if (Math.abs(point.X - last.X) < MIN_POINT_DELTA && Math.abs(point.Y - last.Y) < MIN_POINT_DELTA) {
            return;
        }
        this.activeStroke.push(point);
        this.drawLiveSegment(last, point);
        event.preventDefault();
    }

    public OnPointerUp(event: PointerEvent): void {
        if (!this.Interactive || this.activeStroke === null) {
            return;
        }
        if (this.activePointerId !== null) {
            this.releasePointer(this.activePointerId);
        }
        const points = this.activeStroke;
        this.activeStroke = null;
        this.activePointerId = null;

        if (points.length < 2) {
            return; // a tap with no movement — nothing to emit
        }
        const op: WhiteboardDrawOp = {
            Type: 'stroke',
            Points: points,
            Color: STUDENT_INK_COLOR,
            Width: STUDENT_INK_WIDTH,
        };
        this.ops.push(op);
        this.UserStrokeCompleted.emit(op);
        event.preventDefault();
    }

    /** Toolbar "Clear" button. Clears locally — the parent decides whether to broadcast. */
    public OnClearClicked(): void {
        this.Clear();
    }

    // --- Sizing -------------------------------------------------------------

    private onContainerResize(): void {
        this.syncCanvasSize();
        this.redrawAll();
    }

    private syncCanvasSize(): void {
        const canvas = this.canvasRef.nativeElement;
        const dpr = window.devicePixelRatio || 1;

        const targetCssWidth = this.CanvasWidth > 0 ? this.CanvasWidth : this.host.nativeElement.clientWidth;
        const targetCssHeight = this.CanvasHeight > 0 ? this.CanvasHeight : this.host.nativeElement.clientHeight;

        this.cssWidth = Math.max(0, targetCssWidth);
        this.cssHeight = Math.max(0, targetCssHeight);

        canvas.style.width = `${this.cssWidth}px`;
        canvas.style.height = `${this.cssHeight}px`;
        canvas.width = Math.round(this.cssWidth * dpr);
        canvas.height = Math.round(this.cssHeight * dpr);

        const ctx = canvas.getContext('2d');
        if (ctx) {
            // Draw in CSS pixels; backing store is DPR-scaled for crispness.
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
    }

    // --- Rendering ----------------------------------------------------------

    private getContext(): CanvasRenderingContext2D | null {
        return this.canvasRef.nativeElement.getContext('2d');
    }

    private redrawAll(): void {
        const ctx = this.getContext();
        if (!ctx) {
            return;
        }
        ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
        for (const op of this.ops) {
            this.renderOp(ctx, op);
        }
    }

    private renderOp(ctx: CanvasRenderingContext2D, op: WhiteboardDrawOp): void {
        switch (op.Type) {
            case 'stroke':
                this.renderStroke(ctx, op);
                break;
            case 'shape':
                this.renderShape(ctx, op);
                break;
            case 'text':
                this.renderText(ctx, op);
                break;
            case 'clear':
                ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
                break;
        }
    }

    private renderStroke(ctx: CanvasRenderingContext2D, op: Extract<WhiteboardDrawOp, { Type: 'stroke' }>): void {
        if (op.Points.length < 2) {
            return;
        }
        ctx.save();
        ctx.strokeStyle = op.Color;
        ctx.lineWidth = op.Width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        const first = this.denormalize(op.Points[0]);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < op.Points.length; i++) {
            const p = this.denormalize(op.Points[i]);
            ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
        ctx.restore();
    }

    private renderShape(ctx: CanvasRenderingContext2D, op: Extract<WhiteboardDrawOp, { Type: 'shape' }>): void {
        const x = op.X * this.cssWidth;
        const y = op.Y * this.cssHeight;
        const w = op.W * this.cssWidth;
        const h = op.H * this.cssHeight;

        ctx.save();
        ctx.strokeStyle = op.Color;
        ctx.lineWidth = op.Width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();

        switch (op.Shape) {
            case 'line':
                ctx.moveTo(x, y);
                ctx.lineTo(x + w, y + h);
                break;
            case 'rect':
                ctx.rect(x, y, w, h);
                break;
            case 'ellipse':
                ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
                break;
            case 'triangle':
                ctx.moveTo(x + w / 2, y);
                ctx.lineTo(x + w, y + h);
                ctx.lineTo(x, y + h);
                ctx.closePath();
                break;
            case 'arrow':
                this.tracePath(ctx, this.arrowPoints(x, y, w, h));
                break;
        }
        ctx.stroke();
        ctx.restore();
    }

    private renderText(ctx: CanvasRenderingContext2D, op: Extract<WhiteboardDrawOp, { Type: 'text' }>): void {
        ctx.save();
        ctx.fillStyle = op.Color;
        ctx.font = `${op.FontSize}px sans-serif`;
        ctx.textBaseline = 'top';
        ctx.fillText(op.Text, op.X * this.cssWidth, op.Y * this.cssHeight);
        ctx.restore();
    }

    /** Compute the polyline for an arrow from (x,y) to (x+w, y+h), including the head. */
    private arrowPoints(x: number, y: number, w: number, h: number): { x: number; y: number }[] {
        const tipX = x + w;
        const tipY = y + h;
        const angle = Math.atan2(h, w);
        const headLen = Math.min(18, Math.hypot(w, h) * 0.3);
        const spread = Math.PI / 7;
        return [
            { x, y },
            { x: tipX, y: tipY },
            { x: tipX - headLen * Math.cos(angle - spread), y: tipY - headLen * Math.sin(angle - spread) },
            { x: tipX, y: tipY },
            { x: tipX - headLen * Math.cos(angle + spread), y: tipY - headLen * Math.sin(angle + spread) },
        ];
    }

    private tracePath(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[]): void {
        if (points.length === 0) {
            return;
        }
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y);
        }
    }

    /** Draw a single live segment of the in-progress student stroke (no full redraw). */
    private drawLiveSegment(from: { X: number; Y: number }, to: { X: number; Y: number }): void {
        const ctx = this.getContext();
        if (!ctx) {
            return;
        }
        const a = this.denormalize(from);
        const b = this.denormalize(to);
        ctx.save();
        ctx.strokeStyle = STUDENT_INK_COLOR;
        ctx.lineWidth = STUDENT_INK_WIDTH;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();
    }

    // --- Coordinate helpers -------------------------------------------------

    private denormalize(point: { X: number; Y: number }): { x: number; y: number } {
        return { x: point.X * this.cssWidth, y: point.Y * this.cssHeight };
    }

    private toNormalized(event: PointerEvent): { X: number; Y: number } {
        const rect = this.canvasRef.nativeElement.getBoundingClientRect();
        const width = rect.width || 1;
        const height = rect.height || 1;
        const x = (event.clientX - rect.left) / width;
        const y = (event.clientY - rect.top) / height;
        return { X: this.clamp01(x), Y: this.clamp01(y) };
    }

    private clamp01(value: number): number {
        return Math.min(1, Math.max(0, value));
    }

    private releasePointer(pointerId: number): void {
        const canvas = this.canvasRef.nativeElement;
        if (canvas.hasPointerCapture(pointerId)) {
            canvas.releasePointerCapture(pointerId);
        }
    }
}

/** Tree-shake prevention stub — Wave 2 (widget integration) calls this from public-api. */
export function LoadWhiteboardChannel(): void {}
