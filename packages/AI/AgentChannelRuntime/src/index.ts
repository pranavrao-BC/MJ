/**
 * @memberjunction/ai-agent-channel-runtime — public surface.
 *
 * Only re-exports types/classes defined in THIS package, per MJ's no-re-export
 * rule. Consumers import `BaseRealtimeSpeech`, `AudioFrame`, `ToolDefinition`,
 * etc. directly from `@memberjunction/ai`.
 */
export * from './channel-core';
// actor-core re-exported explicitly: `streamOf` is intentionally omitted here
// because channel-core already exports a `streamOf` (over ChannelBlock). The
// actor-core variant (over Block) stays importable directly from './actor-core'.
export { type Actor, type Block, type BlockKind, type BlockStream, agentActor, collect } from './actor-core';
export * from './ChannelSession';
export * from './BaseChannelEngine';
export * from './engines/TextChatChannelEngine';
export * from './engines/CascadedChannelEngine';
export * from './engines/RealtimeChannelEngine';
export * from './interrupt/InterruptChannel';
export * from './frames/frame-bus';
export * from './types/channel-config';
export * from './types/transcript-event';
export * from './transports/ITransportAdapter';
export * from './transports/WebSocketTransport';
export * from './transports/WebRTCTransport';
export * from './transports/TextInputAudioOutputTransport';
export * from './transports/helpers/IssueLiveKitParticipantToken';
export * from './vad/BaseVAD';
export * from './vad/EnergyVAD';
export * from './vad/SileroVAD';
export * from './turn-detector/BaseTurnDetector';
export * from './turn-detector/SilenceTurnDetector';
