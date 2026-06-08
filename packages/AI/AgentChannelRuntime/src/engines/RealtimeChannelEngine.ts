/**
 * `RealtimeChannelEngine` — PARKED.
 *
 * The realtime (continuous bidirectional speech-to-speech) path is being
 * reworked onto the **AI Agent Sessions** architecture (see
 * `plans/ai-agent-sessions.md`): a session owns the socket and its channels, and
 * each user turn is a normal Loop agent run — there is no separate "realtime"
 * agent type (a new agent type was the wrong shape and has been removed).
 *
 * Until the session/channel work lands, this engine is a no-op stub kept only so
 * the `voice-realtime` channel registration still resolves via ClassFactory.
 * Use the `voice-cascaded` channel for voice in the meantime (a normal Loop
 * agent run with STT in / TTS out).
 */
import { LogStatus } from '@memberjunction/core';
import { RegisterClass } from '@memberjunction/global';
import { BaseChannelEngine, ChannelRunContext, ChannelStopReason } from '../BaseChannelEngine';

@RegisterClass(BaseChannelEngine, 'RealtimeChannelEngine')
export class RealtimeChannelEngine extends BaseChannelEngine {
    public async Run(ctx: ChannelRunContext): Promise<void> {
        LogStatus(
            `[ChannelSession ${ctx.SessionID}] realtime channel is PARKED (migrating to AI Agent Sessions) — use voice-cascaded.`
        );
        ctx.OnTranscript?.({
            Kind: 'error',
            Message:
                'The realtime voice channel is being migrated to AI Agent Sessions. Use the cascaded voice channel for now.',
        });
    }

    public async Stop(_reason: ChannelStopReason): Promise<void> {
        // No live session to stop while parked.
    }
}
