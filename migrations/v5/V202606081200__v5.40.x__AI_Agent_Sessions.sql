------------------------------------------------------------------------
-- AI Agent Sessions & Channels — schema foundation
-- Plan: plans/ai-agent-sessions.md
--
-- Adds the AIAgentSession primitive (a long-lived, stateful, possibly
-- multi-channel wrapper around one or more AIAgentRun executions) plus nullable
-- SessionID links on AIAgentRun and ConversationDetail. Extends the existing
-- AIAgentChannel (a DriverClass-based channel-kind lookup) ADDITIVELY with the
-- pluggable server/client plugin-class registry fields the session host uses.
--
-- The agent run model and LoopAgentResponse are untouched — this is purely the
-- session wrapper layer. The live socket is held in memory by the Session Host;
-- the AIAgentSession row is the durable handle + audit record.
------------------------------------------------------------------------

------------------------------------------------------------------------
-- 1. AIAgentSession
------------------------------------------------------------------------
CREATE TABLE ${flyway:defaultSchema}.AIAgentSession (
    ID UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID(),
    AgentID UNIQUEIDENTIFIER NOT NULL,
    UserID UNIQUEIDENTIFIER NOT NULL,
    Status NVARCHAR(20) NOT NULL
        CONSTRAINT DF_AIAgentSession_Status DEFAULT 'Active'
        CONSTRAINT CK_AIAgentSession_Status CHECK (Status IN ('Active', 'Idle', 'Closed')),
    ConversationID UNIQUEIDENTIFIER NULL,
    Config NVARCHAR(MAX) NULL,
    ActiveChannels NVARCHAR(MAX) NULL,
    LastActiveAt DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_AIAgentSession PRIMARY KEY (ID),
    CONSTRAINT FK_AIAgentSession_Agent FOREIGN KEY (AgentID) REFERENCES ${flyway:defaultSchema}.AIAgent(ID),
    CONSTRAINT FK_AIAgentSession_User FOREIGN KEY (UserID) REFERENCES ${flyway:defaultSchema}.[User](ID),
    CONSTRAINT FK_AIAgentSession_Conversation FOREIGN KEY (ConversationID) REFERENCES ${flyway:defaultSchema}.Conversation(ID)
);

EXEC sp_addextendedproperty
    @name = N'MS_Description',
    @value = N'Lifecycle status of the session: Active (live connection), Idle (no recent activity), Closed (socket terminated). The conversation and its details remain after a session closes.',
    @level0type = N'SCHEMA', @level0name = N'${flyway:defaultSchema}',
    @level1type = N'TABLE',  @level1name = N'AIAgentSession',
    @level2type = N'COLUMN', @level2name = N'Status';

EXEC sp_addextendedproperty
    @name = N'MS_Description',
    @value = N'Session-specific state and variables as a JSON block (e.g. negotiated codecs, per-session settings).',
    @level0type = N'SCHEMA', @level0name = N'${flyway:defaultSchema}',
    @level1type = N'TABLE',  @level1name = N'AIAgentSession',
    @level2type = N'COLUMN', @level2name = N'Config';

EXEC sp_addextendedproperty
    @name = N'MS_Description',
    @value = N'JSON array of the channels currently active on this session, e.g. [{ channelId, socketUrl, status, config }]. Tracked dynamically rather than in a normalized sub-table.',
    @level0type = N'SCHEMA', @level0name = N'${flyway:defaultSchema}',
    @level1type = N'TABLE',  @level1name = N'AIAgentSession',
    @level2type = N'COLUMN', @level2name = N'ActiveChannels';

EXEC sp_addextendedproperty
    @name = N'MS_Description',
    @value = N'Timestamp (with offset) of the last activity on the session, used for idle detection and expiry.',
    @level0type = N'SCHEMA', @level0name = N'${flyway:defaultSchema}',
    @level1type = N'TABLE',  @level1name = N'AIAgentSession',
    @level2type = N'COLUMN', @level2name = N'LastActiveAt';

------------------------------------------------------------------------
-- 2. Link agent runs to their parent session (nullable; NULL = standalone run,
--    i.e. today's one-shot behavior, unchanged).
------------------------------------------------------------------------
ALTER TABLE ${flyway:defaultSchema}.AIAgentRun
    ADD SessionID UNIQUEIDENTIFIER NULL
        CONSTRAINT FK_AIAgentRun_Session FOREIGN KEY (SessionID)
            REFERENCES ${flyway:defaultSchema}.AIAgentSession(ID);

------------------------------------------------------------------------
-- 3. Link conversation details to the session in which they occurred. NULL for
--    messages typed outside any live session; populated for messages produced
--    during an active session (enables grouped "call session" timeline overlays).
------------------------------------------------------------------------
ALTER TABLE ${flyway:defaultSchema}.ConversationDetail
    ADD SessionID UNIQUEIDENTIFIER NULL
        CONSTRAINT FK_ConversationDetail_Session FOREIGN KEY (SessionID)
            REFERENCES ${flyway:defaultSchema}.AIAgentSession(ID);

------------------------------------------------------------------------
-- 4. Extend AIAgentChannel into the pluggable channel registry (ADDITIVE).
--    The existing DriverClass-based rows are untouched; new session channels
--    (VoiceAudio, TextChat, ClientControl, CanvasSync, …) register a server +
--    client plugin class resolved at runtime via ClassFactory. Nullable because
--    existing rows predate these fields.
------------------------------------------------------------------------
ALTER TABLE ${flyway:defaultSchema}.AIAgentChannel ADD
    ServerPluginClass NVARCHAR(250) NULL,
    ClientPluginClass NVARCHAR(250) NULL,
    ConfigSchema NVARCHAR(MAX) NULL;

EXEC sp_addextendedproperty
    @name = N'MS_Description',
    @value = N'ClassFactory registration key for the server-side channel plugin implementing IAgentChannelServer (manages the WebSocket/WebRTC connection and streams data both ways).',
    @level0type = N'SCHEMA', @level0name = N'${flyway:defaultSchema}',
    @level1type = N'TABLE',  @level1name = N'AIAgentChannel',
    @level2type = N'COLUMN', @level2name = N'ServerPluginClass';

EXEC sp_addextendedproperty
    @name = N'MS_Description',
    @value = N'ClassFactory registration key for the client-side channel plugin implementing IAgentChannelClient (establishes the socket, captures user input, renders agent events).',
    @level0type = N'SCHEMA', @level0name = N'${flyway:defaultSchema}',
    @level1type = N'TABLE',  @level1name = N'AIAgentChannel',
    @level2type = N'COLUMN', @level2name = N'ClientPluginClass';

EXEC sp_addextendedproperty
    @name = N'MS_Description',
    @value = N'Optional JSON Schema used to validate the parameters supplied when activating this channel on a session.',
    @level0type = N'SCHEMA', @level0name = N'${flyway:defaultSchema}',
    @level1type = N'TABLE',  @level1name = N'AIAgentChannel',
    @level2type = N'COLUMN', @level2name = N'ConfigSchema';
