/**
 * Everything is an Actor — a thing that reads a stream of blocks and writes a
 * stream of blocks. Agents, channels, tools, sub-agents, and the model itself
 * are all Actors. Delegation is one Actor calling another; rendering is wiring a
 * Channel-Actor to the output. The block's `Kind` is its format. (Generalizes
 * `channel-core.ts`'s `Channel`; inspired by the actor model and
 * earendil-works/pi's content-block minimalism.)
 */
import type { DrawOp } from './types/transcript-event';

// The unit. Kind = format. (adds tool/tool_result to the channel-core block set)
export type Block =
    | { Kind: 'text'; Text: string }
    | { Kind: 'audio'; Data: Uint8Array; SampleRateHz: number; ChannelCount: number }
    | { Kind: 'draw'; Op: DrawOp }
    | { Kind: 'tool'; CallID: string; Name: string; Arguments: Record<string, unknown> }
    | { Kind: 'tool_result'; CallID: string; Result?: string; Error?: string }
    | { Kind: 'thinking'; Text: string };

export type BlockKind = Block['Kind'];

// Dual stream/result. iterate for live, result() for the assembled set.
export interface BlockStream extends AsyncIterable<Block> {
    result(): Promise<Block[]>;
}

// THE primitive: an Actor reads blocks and writes blocks. Everything is one.
export type Actor = (input: BlockStream) => BlockStream;

// Build a BlockStream from a fixed array — async-iterable + result().
export function streamOf(blocks: readonly Block[]): BlockStream {
    const snapshot = [...blocks];
    return {
        async *[Symbol.asyncIterator](): AsyncIterator<Block> {
            for (const block of snapshot) {
                yield block;
            }
        },
        result(): Promise<Block[]> {
            return Promise.resolve([...snapshot]);
        },
    };
}

// Drain any block source to an array.
export async function collect(stream: AsyncIterable<Block>): Promise<Block[]> {
    const out: Block[] = [];
    for await (const block of stream) {
        out.push(block);
    }
    return out;
}

/**
 * An async push-queue: a buffer you can `push` into and `await` out of, even
 * when the consumer is faster than the producer. `seal()` ends the stream once
 * the buffer drains. This is what lets the Brain's input stay open so
 * tool_results can be fed back in after the Brain has already started emitting.
 */
class BlockQueue implements AsyncIterable<Block> {
    private readonly buffer: Block[] = [];
    private readonly waiters: ((value: IteratorResult<Block>) => void)[] = [];
    private sealed = false;

    push(block: Block): void {
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter({ value: block, done: false });
        } else {
            this.buffer.push(block);
        }
    }

    seal(): void {
        this.sealed = true;
        let waiter = this.waiters.shift();
        while (waiter) {
            waiter({ value: undefined, done: true });
            waiter = this.waiters.shift();
        }
    }

    async *[Symbol.asyncIterator](): AsyncIterator<Block> {
        while (true) {
            if (this.buffer.length > 0) {
                yield this.buffer.shift() as Block;
                continue;
            }
            if (this.sealed) {
                return;
            }
            const next = await new Promise<IteratorResult<Block>>((resolve) => this.waiters.push(resolve));
            if (next.done) {
                return;
            }
            yield next.value;
        }
    }
}

/**
 * The composite Actor. Runs `Brain` over the agent's input; passes `text` /
 * `thinking` straight through to output the instant the Brain emits them; routes
 * each `tool` block by `Name` to the matching Tool Actor, then feeds the
 * resulting `tool_result` BOTH back into the Brain's input (so it can react) AND
 * out to the agent's output. The Brain's input is a live queue, so the Brain
 * never blocks on a tool — filler text emitted before a tool_result arrives
 * flows out immediately ("talk-while-delegating"). Finishes when the Brain ends.
 */
export function agentActor(opts: { Brain: Actor; Tools: Record<string, Actor> }): Actor {
    const { Brain, Tools } = opts;
    return (input: BlockStream): BlockStream => {
        // The agent's output is its own live queue: the brain-drain pushes text/
        // thinking immediately, and tool runs push their results as they settle —
        // concurrently, so the brain is never blocked waiting on a tool.
        const output = new BlockQueue();
        const brainInput = new BlockQueue();

        // Run a `tool` block through its Actor; push the result to brain input + output.
        const runTool = async (call: Extract<Block, { Kind: 'tool' }>): Promise<void> => {
            const tool = Tools[call.Name];
            if (!tool) {
                const error: Block = { Kind: 'tool_result', CallID: call.CallID, Error: `No tool named '${call.Name}'` };
                brainInput.push(error);
                output.push(error);
                return;
            }
            for await (const resultBlock of tool(streamOf([call]))) {
                brainInput.push(resultBlock);
                output.push(resultBlock);
            }
        };

        // Drive everything: feed the brain, drain the brain, fire tools concurrently, then seal.
        (async () => {
            const seed = (async () => {
                for await (const block of input) {
                    brainInput.push(block);
                }
            })();

            const toolRuns: Promise<void>[] = [];
            for await (const block of Brain(toStream(brainInput))) {
                output.push(block); // tool / text / thinking / draw / audio all flow out immediately
                if (block.Kind === 'tool') {
                    toolRuns.push(runTool(block)); // concurrent — do NOT await, the brain keeps going
                }
            }

            await Promise.all(toolRuns);
            await seed;
            brainInput.seal();
            output.seal();
        })();

        return toStream(output);
    };
}

// Wrap any async source into the dual stream/result primitive.
function toStream(source: AsyncIterable<Block>): BlockStream {
    let assembled: Promise<Block[]> | undefined;
    const collected: Block[] = [];
    const iterator = source[Symbol.asyncIterator]();
    return {
        [Symbol.asyncIterator](): AsyncIterator<Block> {
            return {
                async next(): Promise<IteratorResult<Block>> {
                    const step = await iterator.next();
                    if (!step.done) {
                        collected.push(step.value);
                    }
                    return step;
                },
            };
        },
        result(): Promise<Block[]> {
            if (!assembled) {
                assembled = (async () => {
                    // Drain the underlying iterator, filling `collected`.
                    let step = await iterator.next();
                    while (!step.done) {
                        collected.push(step.value);
                        step = await iterator.next();
                    }
                    return collected;
                })();
            }
            return assembled;
        },
    };
}
