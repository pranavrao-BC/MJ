import { describe, it, expect } from 'vitest';
import { RunChannels, streamOf, type Channel, type ChannelBlock } from '../channel-core';

/** Collects rendered text and tool labels — ignores everything else. */
class TextChannel implements Channel {
    readonly Name = 'text';
    readonly Accepts = ['text', 'tool'] as const;
    readonly Text: string[] = [];
    readonly ToolLabels: string[] = [];
    Render(block: ChannelBlock): void {
        if (block.Kind === 'text') {
            this.Text.push(block.Text);
        } else if (block.Kind === 'tool') {
            this.ToolLabels.push(block.Label ?? block.Name);
        }
    }
}

/** Speaks text, counts audio frames — never sees draw or tool blocks. */
class VoiceChannel implements Channel {
    readonly Name = 'voice';
    readonly Accepts = ['text', 'audio'] as const;
    readonly Spoken: string[] = [];
    AudioFrames = 0;
    Render(block: ChannelBlock): void {
        if (block.Kind === 'text') {
            this.Spoken.push(block.Text);
        } else if (block.Kind === 'audio') {
            this.AudioFrames++;
        }
    }
}

/** Paints draw ops onto a canvas — sees nothing else. */
class WhiteboardChannel implements Channel {
    readonly Name = 'whiteboard';
    readonly Accepts = ['draw'] as const;
    readonly Ops: ChannelBlock[] = [];
    Render(block: ChannelBlock): void {
        if (block.Kind === 'draw') {
            this.Ops.push(block);
        }
    }
}

describe('RunChannels', () => {
    it('routes each block to only the channels whose Accepts include its Kind (format = Kind)', async () => {
        const text = new TextChannel();
        const voice = new VoiceChannel();
        const whiteboard = new WhiteboardChannel();

        const stream = streamOf([
            { Kind: 'text', Text: 'hello world' },
            { Kind: 'audio', Data: new Uint8Array([1, 2, 3]), SampleRateHz: 24000, ChannelCount: 1 },
            { Kind: 'draw', Op: { Type: 'text', X: 0.1, Y: 0.1, Text: 'hi', Color: '#000', FontSize: 16 } },
            { Kind: 'tool', CallID: 'c1', Name: 'search', Status: 'complete', Label: 'Searched the web' },
            { Kind: 'thinking', Text: 'pondering...' },
        ]);

        await RunChannels(stream, [text, voice, whiteboard]);

        // TextChannel: got text + tool, NOT audio/draw/thinking.
        expect(text.Text).toEqual(['hello world']);
        expect(text.ToolLabels).toEqual(['Searched the web']);

        // VoiceChannel: got text + audio frame, NOT draw/tool.
        expect(voice.Spoken).toEqual(['hello world']);
        expect(voice.AudioFrames).toBe(1);

        // WhiteboardChannel: got only the draw op.
        expect(whiteboard.Ops).toHaveLength(1);
        expect(whiteboard.Ops[0]).toMatchObject({ Kind: 'draw', Op: { Type: 'text', Text: 'hi' } });
    });

    it('silently ignores blocks no channel accepts (thinking has no subscriber)', async () => {
        const text = new TextChannel();
        const voice = new VoiceChannel();
        const whiteboard = new WhiteboardChannel();

        const stream = streamOf([{ Kind: 'thinking', Text: 'internal only' }]);

        // No channel Accepts 'thinking' — must complete without throwing and render nothing.
        await expect(RunChannels(stream, [text, voice, whiteboard])).resolves.toBeUndefined();
        expect(text.Text).toEqual([]);
        expect(voice.Spoken).toEqual([]);
        expect(whiteboard.Ops).toEqual([]);
    });
});

describe('streamOf', () => {
    it('result() resolves to the full block array (dual stream/result behavior)', async () => {
        const blocks: ChannelBlock[] = [
            { Kind: 'text', Text: 'a' },
            { Kind: 'thinking', Text: 'b' },
        ];
        const stream = streamOf(blocks);
        await expect(stream.result()).resolves.toEqual(blocks);
    });
});
