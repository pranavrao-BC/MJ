/**
 * The proof: one primitive — the Actor — unifies brain, tools, sub-agents, and
 * channels. The scene below is the smallest thing that demonstrates the whole
 * architecture: an agent that talks while it delegates, a tool that answers
 * asynchronously, a sub-agent wired exactly like a tool, and a channel that
 * renders purely by block Kind.
 */
import { describe, it, expect } from 'vitest';
import { type Actor, type Block, type BlockStream, agentActor, streamOf, collect } from '../actor-core';

// A fake Brain: emits filler text BEFORE the tool result arrives (non-blocking),
// then awaits the tool_result fed back into its input, then answers.
const Brain: Actor = (input: BlockStream): BlockStream => {
    async function* think(): AsyncGenerator<Block> {
        const iterator = input[Symbol.asyncIterator]();
        await iterator.next(); // the user's text block
        yield { Kind: 'text', Text: 'Sure — let me work that out…' };
        yield { Kind: 'tool', CallID: 'c1', Name: 'calc', Arguments: { expr: '2+2' } };
        yield { Kind: 'text', Text: '…still with you while that runs…' };
        await iterator.next(); // the tool_result, fed back into the brain's input
        yield { Kind: 'text', Text: 'the answer is 4.' };
    }
    return wrap(think());
};

// A calc Tool Actor: reads tool blocks, answers asynchronously (after a tick).
const calc: Actor = (input: BlockStream): BlockStream => {
    async function* run(): AsyncGenerator<Block> {
        for await (const block of input) {
            if (block.Kind === 'tool') {
                await Promise.resolve();
                yield { Kind: 'tool_result', CallID: block.CallID, Result: '4' };
            }
        }
    }
    return wrap(run());
};

// A sub-agent Actor — identical SHAPE to a tool. Delegation = Actor calling
// Actor: a sub-agent is just an Actor wired into the Tools map.
const subAgent: Actor = (input: BlockStream): BlockStream => {
    async function* run(): AsyncGenerator<Block> {
        for await (const block of input) {
            if (block.Kind === 'tool') {
                yield { Kind: 'tool_result', CallID: block.CallID, Result: 'delegated' };
            }
        }
    }
    return wrap(run());
};

// A Text Channel Actor: renders by Kind — collects text blocks, ignores the rest.
const textChannel: Actor = (input: BlockStream): BlockStream => {
    async function* render(): AsyncGenerator<Block> {
        for await (const block of input) {
            if (block.Kind === 'text') {
                yield block;
            }
        }
    }
    return wrap(render());
};

// Minimal BlockStream wrapper around an async generator (iterate-only; tests use collect()).
function wrap(source: AsyncGenerator<Block>): BlockStream {
    return {
        [Symbol.asyncIterator]: () => source[Symbol.asyncIterator](),
        async result(): Promise<Block[]> {
            return collect(source);
        },
    };
}

describe('Actor — the unifying primitive', () => {
    const buildAgent = () => agentActor({ Brain, Tools: { calc, helper: subAgent } });
    const userInput = (): BlockStream => streamOf([{ Kind: 'text', Text: 'calc 2+2 and keep me company' }]);

    it('delegation = Actor calling Actor: the tool runs and its tool_result flows back into the agent output', async () => {
        const out = await collect(buildAgent()(userInput()));
        const toolCall = out.find((b) => b.Kind === 'tool');
        const toolResult = out.find((b) => b.Kind === 'tool_result');
        expect(toolCall).toBeDefined();
        expect(toolCall?.Kind === 'tool' && toolCall.Name).toBe('calc');
        expect(toolResult?.Kind === 'tool_result' && toolResult.Result).toBe('4');
    });

    it('talk-while-delegating: filler text is emitted BEFORE the tool_result (brain never stalls on the tool)', async () => {
        const out = await collect(buildAgent()(userInput()));
        const fillerIndex = out.findIndex((b) => b.Kind === 'text' && b.Text === '…still with you while that runs…');
        const resultIndex = out.findIndex((b) => b.Kind === 'tool_result');
        expect(fillerIndex).toBeGreaterThanOrEqual(0);
        expect(resultIndex).toBeGreaterThanOrEqual(0);
        expect(fillerIndex).toBeLessThan(resultIndex);
    });

    it('the final answer incorporates the result: "the answer is 4." comes after the tool_result', async () => {
        const out = await collect(buildAgent()(userInput()));
        const answerIndex = out.findIndex((b) => b.Kind === 'text' && b.Text === 'the answer is 4.');
        const resultIndex = out.findIndex((b) => b.Kind === 'tool_result');
        expect(answerIndex).toBeGreaterThan(resultIndex);
    });

    it('channels render by Kind: the Text Channel collects exactly the text blocks (3), no tool/tool_result', async () => {
        const rendered = await collect(textChannel(buildAgent()(userInput())));
        expect(rendered).toHaveLength(3);
        expect(rendered.every((b) => b.Kind === 'text')).toBe(true);
        expect(rendered.map((b) => (b.Kind === 'text' ? b.Text : ''))).toEqual([
            'Sure — let me work that out…',
            '…still with you while that runs…',
            'the answer is 4.',
        ]);
    });

    it('dual stream/result: streamOf([...]).result() returns the full array', async () => {
        const blocks: Block[] = [
            { Kind: 'text', Text: 'a' },
            { Kind: 'thinking', Text: 'b' },
        ];
        expect(await streamOf(blocks).result()).toEqual(blocks);
    });
});
