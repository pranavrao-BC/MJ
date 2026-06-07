import {
    ChangeDetectorRef,
    Component,
    Input,
    OnDestroy,
    OnInit,
    ViewEncapsulation,
    inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';

import { RunActor, RunBlock } from '../voice-widget.types';

/**
 * `<mj-run-timeline>` — a clean, live view of the agent **block + actor model**.
 * For each actor (the root agent, plus any delegated sub-agents) it shows the
 * blocks flowing IN (consumed) and OUT (emitted), so the "an actor takes these
 * blocks and produces those" flow reads at a glance. Sub-agents render nested
 * under the agent that delegated to them.
 *
 * **Purely presentational.** It takes its data via `@Input() Actors` and renders
 * reactively — there is NO imperative feed, no `@ViewChild`, no transcript
 * parsing here. The widget owns the `RunActor[]` model and pushes it down. The
 * only state this component owns is a 1s "now" tick so running actors can show
 * a climbing elapsed timer.
 *
 * Generic-package constraints: standalone, `inject()` DI, `@if`/`@for` (+
 * `track`), design tokens for all chrome, no Router, no `any`.
 */
@Component({
    selector: 'mj-run-timeline',
    standalone: true,
    imports: [CommonModule],
    templateUrl: './run-timeline.component.html',
    styleUrls: ['./run-timeline.component.scss'],
    encapsulation: ViewEncapsulation.Emulated,
})
export class RunTimelineComponent implements OnInit, OnDestroy {
    /** The actors to render, owned + updated by the parent widget. */
    @Input() public Actors: RunActor[] = [];

    /**
     * Monotonic "now" tick, refreshed every second while any actor is running.
     * Read by `ElapsedLabel` so running actors show a climbing timer without the
     * parent having to push a new array on every frame.
     */
    public Now = Date.now();

    private readonly cdr = inject(ChangeDetectorRef);
    private tickTimer: ReturnType<typeof setInterval> | null = null;

    // -- Lifecycle ----------------------------------------------------------

    public ngOnInit(): void {
        // A single 1s interval drives the live elapsed timer for running actors.
        this.tickTimer = setInterval(() => {
            this.Now = Date.now();
            this.cdr.markForCheck();
        }, 1000);
    }

    public ngOnDestroy(): void {
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
    }

    // -- Template helpers ---------------------------------------------------

    /**
     * Font Awesome icon for an actor's header — the "machine" mark. The root
     * agent gets a brain (it drives), sub-agents get a robot (delegated worker).
     */
    public ActorIcon(actor: RunActor): string {
        return actor.Kind === 'sub-agent' ? 'fa-solid fa-robot' : 'fa-solid fa-brain';
    }

    /** UPPERCASE kind portion of the actor badge ("AGENT" / "SUB-AGENT"). */
    public ActorKindLabel(actor: RunActor): string {
        return actor.Kind === 'sub-agent' ? 'SUB-AGENT' : 'AGENT';
    }

    /** Short directional marker text for a block chip ("IN" / "OUT"). */
    public BlockDirectionLabel(block: RunBlock): string {
        return block.Direction === 'in' ? 'IN' : 'OUT';
    }

    /**
     * Right-aligned elapsed/duration label for an actor.
     *   - running  → live-ticking elapsed, e.g. "0:12"
     *   - complete → final duration, e.g. "15.0s"
     *   - error    → "Failed · 4.2s"
     * `active` (the root agent's resting state) shows nothing.
     */
    public ElapsedLabel(actor: RunActor): string {
        if (actor.Status === 'active') {
            return '';
        }
        if (actor.Status === 'running') {
            const startedAt = actor.StartedAt ?? this.Now;
            const seconds = Math.max(0, Math.floor((this.Now - startedAt) / 1000));
            const mins = Math.floor(seconds / 60);
            const secs = seconds % 60;
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        }
        const ms = actor.DurationMs ?? 0;
        const durationLabel = `${(ms / 1000).toFixed(1)}s`;
        return actor.Status === 'error' ? `Failed · ${durationLabel}` : durationLabel;
    }

    /** Font Awesome icon class for a block, by kind. */
    public BlockIcon(block: RunBlock): string {
        switch (block.Kind) {
            case 'user':
                return 'fa-solid fa-user';
            case 'text':
                return 'fa-solid fa-comment';
            case 'audio':
                return 'fa-solid fa-volume-high';
            case 'tool-call':
                return 'fa-solid fa-diagram-project';
            case 'tool-result':
                return 'fa-solid fa-arrow-turn-up';
            case 'draw':
                return 'fa-solid fa-pen-nib';
            default:
                return 'fa-solid fa-circle';
        }
    }

    /** Human kind label for a block, by kind. */
    public BlockKindLabel(block: RunBlock): string {
        switch (block.Kind) {
            case 'user':
                return 'user';
            case 'text':
                return 'text';
            case 'audio':
                return 'audio';
            case 'tool-call':
                return 'tool call';
            case 'tool-result':
                return 'tool result';
            case 'draw':
                return 'draw';
            default:
                return block.Kind;
        }
    }

    public TrackByActorId(_index: number, actor: RunActor): string {
        return actor.Id;
    }

    public TrackByBlockIndex(index: number): number {
        return index;
    }
}

/** Tree-shake prevention stub — widget integration calls this from public-api. */
export function LoadRunTimeline(): void {}
