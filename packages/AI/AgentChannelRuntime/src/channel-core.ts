/**
 * Channels core — the proposed minimal substrate for multi-modal agent output.
 *
 * Thesis: a channel = a subscriber to certain block types, rendering at its own
 * clock. The block's `Kind` IS its output format — channels filter by `Kind`; no
 * JSON envelope ever reaches a channel. The streaming substrate mirrors
 * `@memberjunction/ai-core-plus`'s `AgentStreamEvent` (an `AsyncIterable` paired
 * with a `result()` that resolves the assembled set); this is the channel-facing
 * unification of "live stream" and "final payload" into one primitive.
 *
 * This is a proposed-design artifact (inspired by the content-block minimalism of
 * earendil-works/pi). It stands alone — it is intentionally NOT wired into the
 * live engines or widget.
 */
import type { DrawOp } from './types/transcript-event';

// One block union — the block's Kind IS its format contract.
export type ChannelBlock =
    | { Kind: 'text'; Text: string }
    | { Kind: 'audio'; Data: Uint8Array; SampleRateHz: number; ChannelCount: number }
    | { Kind: 'draw'; Op: DrawOp }
    | { Kind: 'tool'; CallID: string; Name: string; Status: 'running' | 'complete' | 'error'; Label?: string; Detail?: string }
    | { Kind: 'thinking'; Text: string };

export type ChannelBlockKind = ChannelBlock['Kind'];

// Dual stream/result primitive (pi's AssistantMessageEventStream shape; mirrors MJ's AgentEventStream):
// iterate for live, await result() for the assembled set.
export interface ChannelBlockStream extends AsyncIterable<ChannelBlock> {
    result(): Promise<ChannelBlock[]>;
}

// A channel: which block Kinds it consumes + how it renders (at its own clock).
// Optionally emits user input back as blocks (bidirectional).
export interface Channel {
    readonly Name: string;
    readonly Accepts: readonly ChannelBlockKind[];
    Render(block: ChannelBlock): void | Promise<void>;
    Emit?(block: ChannelBlock): void;
}

// Fan one block stream out to N channels — each renders only the Kinds it Accepts, independently.
export async function RunChannels(stream: AsyncIterable<ChannelBlock>, channels: readonly Channel[]): Promise<void> {
    for await (const block of stream) {
        for (const channel of channels) {
            if (channel.Accepts.includes(block.Kind)) {
                await channel.Render(block);
            }
        }
    }
}

// Helper: build a ChannelBlockStream from a fixed array (for tests/demos) — async-iterable + result().
export function streamOf(blocks: readonly ChannelBlock[]): ChannelBlockStream {
    const snapshot = [...blocks];
    return {
        async *[Symbol.asyncIterator](): AsyncIterator<ChannelBlock> {
            for (const block of snapshot) {
                yield block;
            }
        },
        result(): Promise<ChannelBlock[]> {
            return Promise.resolve([...snapshot]);
        },
    };
}
