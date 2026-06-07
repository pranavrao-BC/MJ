import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject, Subscription, firstValueFrom } from 'rxjs';
import { GraphQLDataProvider } from '@memberjunction/graphql-dataprovider';
import { ActiveTasksService } from './active-tasks.service';
import { DataCacheService } from './data-cache.service';
import { MJConversationDetailEntity } from '@memberjunction/core-entities';
import { UserInfo } from '@memberjunction/core';
import { AgentStreamBlock } from '@memberjunction/ai-core-plus';

/**
 * Completion event structure broadcast when an agent finishes.
 * Includes enriched result data from the server's fire-and-forget completion event.
 */
export interface CompletionEvent {
  conversationDetailId: string;
  agentRunId: string;
  /** Whether the agent execution succeeded */
  success?: boolean;
  /** Error message if the agent execution failed */
  errorMessage?: string;
}

/**
 * Metadata structure for message progress updates
 */
export interface MessageProgressMetadata {
  /** Progress details (from RunAIAgentResolver) */
  progress?: {
    hierarchicalStep?: string;
    percentage?: number;
    message?: string;
    stepCount?: number;
    agentName?: string;
    agentType?: string;
  };
  /** Agent run information (from RunAIAgentResolver) */
  agentRun?: {
    Agent?: string;
    ConversationDetailID?: string;
    ID?: string;
  };
  /** Agent run ID (alternative to agentRun.ID) */
  agentRunId?: string;
}

/**
 * Message progress update structure
 */
export interface MessageProgressUpdate {
  message: string;
  percentComplete?: number;
  taskName?: string;
  conversationDetailId: string;
  metadata?: MessageProgressMetadata;
  stepCount?: number;
  /** Identifies which backend resolver published this update */
  resolver?: 'TaskOrchestrator' | 'RunAIAgentResolver' | string;
  /**
   * Typed content block (when the backend supplied one on this streaming chunk).
   * Carried verbatim from `data.streaming.block`. Renderers switch on `block.Kind`
   * to draw text / thinking / tool-call / html blocks live during a run.
   */
  block?: AgentStreamBlock;
}

/**
 * Callback type for message progress updates
 */
export type MessageProgressCallback = (progress: MessageProgressUpdate) => Promise<void> | void;

/**
 * Connection status for streaming service
 */
export type StreamingConnectionStatus = 'connected' | 'disconnected' | 'error' | 'reconnecting';

/**
 * Global streaming service that manages PubSub subscriptions for all conversations.
 *
 * This service maintains a single WebSocket connection and routes updates to all
 * registered message callbacks, regardless of which conversation is currently visible.
 * This ensures that messages update correctly even when users navigate away and return.
 */
@Injectable({
  providedIn: 'root'
})
export class ConversationStreamingService implements OnDestroy {
  // Single PubSub subscription shared across the entire app
  private pushStatusSubscription?: Subscription;

  // Registry of callbacks per conversation detail ID
  // Multiple callbacks can be registered for the same message (e.g., different components)
  private callbackRegistry = new Map<string, MessageProgressCallback[]>();

  // Track recent completions for late-arriving components (e.g., after navigation)
  // Key: conversationDetailId, Value: completion info with timestamp
  private recentCompletions = new Map<string, {
    conversationDetailId: string;
    agentRunId: string;
    timestamp: Date;
  }>();

  // Ordered, accumulated typed content blocks per in-progress AI message.
  // Key: conversationDetailId, Value: blocks in arrival order. A `tool-result`
  // block is merged into the prior `tool-call` with the same CallID (it updates
  // that call's Status/Detail) rather than being stored separately.
  private streamingBlocks = new Map<string, AgentStreamBlock[]>();

  // Observable for components to subscribe to completion events in real-time
  public completionEvents$ = new Subject<CompletionEvent>();

  // Subject to emit connection status changes
  private connectionStatus$ = new BehaviorSubject<StreamingConnectionStatus>('disconnected');

  // Track if service has been initialized
  private initialized = false;

  // Reconnection timeout
  private reconnectionTimeout?: any;

  constructor(
    private activeTasks: ActiveTasksService,
    private dataCache: DataCacheService
  ) {
  }

  /**
   * Initialize the global PubSub subscription.
   * Should be called once at app startup (e.g., in workspace component).
   */
  public initialize(): void {
    if (this.initialized) {
      return;
    }


    try {
      const dataProvider = GraphQLDataProvider.Instance;
      const sessionId = (dataProvider as any).sessionId || (dataProvider as any)._sessionId;

      this.pushStatusSubscription = dataProvider.PushStatusUpdates().subscribe({
        next: (status: any) => {
          this.handlePushStatusUpdate(status);
        },
        error: (error: any) => {
          console.error('[ConversationStreamingService] PubSub connection error:', error);
          this.connectionStatus$.next('error');
          this.scheduleReconnection();
        },
        complete: () => {
          this.connectionStatus$.next('disconnected');
          this.scheduleReconnection();
        }
      });

      this.initialized = true;
      this.connectionStatus$.next('connected');
    } catch (error) {
      console.error('[ConversationStreamingService] Failed to initialize:', error);
      this.connectionStatus$.next('error');
      this.scheduleReconnection();
    }
  }

  /**
   * Get the current connection status as an observable
   */
  public getConnectionStatus$() {
    return this.connectionStatus$.asObservable();
  }

  /**
   * Get the current connection status value
   */
  public getConnectionStatus(): StreamingConnectionStatus {
    return this.connectionStatus$.value;
  }

  /**
   * Register a callback for a specific conversation detail (message).
   * The callback will be invoked whenever progress updates arrive for this message.
   *
   * @param conversationDetailId - The ID of the conversation detail entity
   * @param callback - Function to call with progress updates
   */
  public registerMessageCallback(
    conversationDetailId: string,
    callback: MessageProgressCallback
  ): void {
    const existing = this.callbackRegistry.get(conversationDetailId) || [];
    existing.push(callback);
    this.callbackRegistry.set(conversationDetailId, existing);
  }

  /**
   * Unregister a callback for a specific conversation detail.
   * If no callback is provided, all callbacks for the message are removed.
   *
   * @param conversationDetailId - The ID of the conversation detail entity
   * @param callback - Optional specific callback to remove
   */
  public unregisterMessageCallback(
    conversationDetailId: string,
    callback?: MessageProgressCallback
  ): void {
    if (callback) {
      // Remove specific callback
      const existing = this.callbackRegistry.get(conversationDetailId) || [];
      const filtered = existing.filter(cb => cb !== callback);

      if (filtered.length > 0) {
        this.callbackRegistry.set(conversationDetailId, filtered);
      } else {
        this.callbackRegistry.delete(conversationDetailId);
      }
    } else {
      // Remove all callbacks for this message
      const hadCallbacks = this.callbackRegistry.has(conversationDetailId);
      this.callbackRegistry.delete(conversationDetailId);

      if (hadCallbacks) {
        // console.log(`[ConversationStreamingService] Unregistered all callbacks for message ${conversationDetailId}`);
      }
    }
  }

  /**
   * Get the number of registered callbacks (for monitoring/debugging)
   */
  public getRegisteredCallbackCount(): number {
    let count = 0;
    for (const callbacks of this.callbackRegistry.values()) {
      count += callbacks.length;
    }
    return count;
  }

  /**
   * Get the number of messages being tracked (for monitoring/debugging)
   */
  public getTrackedMessageCount(): number {
    return this.callbackRegistry.size;
  }

  /**
   * Handle incoming PubSub status updates and route to registered callbacks
   */
  private async handlePushStatusUpdate(status: any): Promise<void> {

    if (!status) {
      console.warn('PubSub status is null or undefined');
      return;
    }

    try {
      // Parse the status if it's a JSON string, otherwise use as-is
      // GraphQL subscription emits JSON strings that need to be parsed
      const statusObj = typeof status === 'string' ? JSON.parse(status) : status;

      // Handle both resolver types for agent progress updates
      if (statusObj.resolver === 'TaskOrchestrator') {
        // Task graph execution (multi-step workflows)
        await this.routeTaskProgress(statusObj);
      } else if (statusObj.resolver === 'RunAIAgentResolver') {
        // Direct agent execution (Sage, Research Agent, etc.)
        await this.routeAgentProgress(statusObj);
      } else {
      }

    } catch (error) {
      console.error('[ConversationStreamingService] Error processing push status update:', error);
    }
  }

  /**
   * Route task progress updates to registered callbacks.
   * Uses conversationDetailId from PubSub message for direct routing.
   */
  private async routeTaskProgress(statusObj: any): Promise<void> {
    try {
      // Extract progress information from status object
      const { taskName, message, percentComplete, metadata, conversationDetailId } = statusObj.data || {};

      // console.log(`[ConversationStreamingService] 📥 Received progress update:`, {
      //   taskName,
      //   hasMessage: !!message,
      //   conversationDetailId,
      //   registeredCallbacks: Array.from(this.callbackRegistry.keys())
      // });

      if (!message) {
        console.warn('[ConversationStreamingService] ⚠️  No message content in progress update');
        return; // No message content to update
      }

      if (!conversationDetailId) {
        console.warn('[ConversationStreamingService] ⚠️  Progress update missing conversationDetailId, cannot route', { taskName, message });
        return;
      }

      // Direct lookup using conversationDetailId from backend
      const callbacks = this.callbackRegistry.get(conversationDetailId) || [];

      if (callbacks.length === 0) {
        // No callbacks registered - expected when progress is handled directly by graphQLAIClient's
        // fire-and-forget subscription, or when the message is in a hidden conversation.
        return;
      }

      // Create progress update object
      const progressUpdate: MessageProgressUpdate = {
        message,
        percentComplete,
        taskName,
        conversationDetailId,
        metadata,
        resolver: 'TaskOrchestrator'
      };

      // Invoke all registered callbacks for this specific message
      for (const callback of callbacks) {
        try {
          await callback(progressUpdate);
        } catch (error) {
          console.error(`[ConversationStreamingService] Error executing callback for message ${conversationDetailId}:`, error);
          // Continue with other callbacks even if one fails
        }
      }

      // console.log(`[ConversationStreamingService] ✅ Routed progress update to message ${conversationDetailId} (${callbacks.length} callback(s))`);

    } catch (error) {
      console.error('[ConversationStreamingService] Error routing task progress:', error);
    }
  }

  /**
   * Route agent progress updates (from RunAIAgentResolver) to registered callbacks.
   * Uses conversationDetailID from agentRun data for direct routing.
   * Also handles completion messages to remove tasks from ActiveTasksService.
   */
  private async routeAgentProgress(statusObj: any): Promise<void> {
    try {
      // Extract progress information from RunAIAgentResolver message
      const { agentRun, progress, type, streaming } = statusObj.data || {};

      // Handle streaming content chunks (type: 'streaming' / 'StreamingContent').
      // These carry a typed `block` (and/or a `content` string) for live rendering.
      if (streaming && type !== 'complete') {
        await this.routeStreamingChunk(agentRun, streaming);
        return;
      }

      // Handle completion messages - backend sends type: 'complete' when agent finishes.
      // Now includes conversationDetailId and enriched result data (success, errorMessage, result)
      // from the server's fire-and-forget execution.
      if (type === 'complete') {
        const agentRunId = statusObj.data?.agentRunId;
        const conversationDetailId = statusObj.data?.conversationDetailId;
        const success = statusObj.data?.success;
        const errorMessage = statusObj.data?.errorMessage;

        // Remove from active tasks (clears spinner in conversation list)
        if (agentRunId) {
          const removed = this.activeTasks.removeByAgentRunId(agentRunId);
          if (removed) {
            console.log(`[ConversationStreamingService] ✅ Agent run ${agentRunId} completed, removed from active tasks`);
          }
        }

        // Broadcast completion event if we have the conversationDetailId
        if (conversationDetailId) {
          // Drop accumulated streaming blocks — the finalized message.Message now
          // renders, so the in-progress block view must stop (avoids double-render).
          this.clearStreamingBlocks(conversationDetailId);

          // Store for late-arriving components (navigation scenario)
          this.recentCompletions.set(conversationDetailId, {
            conversationDetailId,
            agentRunId: agentRunId || '',
            timestamp: new Date()
          });

          // Broadcast enriched completion to all subscribers
          this.completionEvents$.next({
            conversationDetailId,
            agentRunId: agentRunId || '',
            success,
            errorMessage
          });

          // Cleanup old completions to prevent memory leak
          this.cleanupOldCompletions();

          console.log(`[ConversationStreamingService] 📢 Completion broadcast for message ${conversationDetailId} (success: ${success})`);
        } else {
          console.warn(`[ConversationStreamingService] ⚠️ Completion received without conversationDetailId for agentRunId: ${agentRunId}`);
        }

        return;
      }

      const conversationDetailId = agentRun?.ConversationDetailID;
      const message = progress?.message;
      const percentComplete = progress?.percentage;
      const stepCount = progress?.stepCount;

      if (!message) {
        console.warn('[ConversationStreamingService] ⚠️  No message content in agent progress update');
        return;
      }

      if (!conversationDetailId) {
        console.warn('[ConversationStreamingService] ⚠️  Agent progress update missing conversationDetailId', { agentName: agentRun?.Agent, message });
        return;
      }

      // Direct lookup using conversationDetailID from backend
      const callbacks = this.callbackRegistry.get(conversationDetailId) || [];

      if (callbacks.length === 0) {
        // No callbacks registered - expected when progress is handled directly by graphQLAIClient's
        // fire-and-forget subscription, or when the message is in a hidden conversation.
        return;
      }

      // Create progress update object
      const progressUpdate: MessageProgressUpdate = {
        message,
        percentComplete,
        taskName: agentRun?.Agent || 'Agent',
        conversationDetailId,
        metadata: { agentRun, progress } as MessageProgressMetadata,
        stepCount,
        resolver: 'RunAIAgentResolver'
      };

      // Invoke all registered callbacks for this specific message
      for (const callback of callbacks) {
        try {
          await callback(progressUpdate);
        } catch (error) {
          console.error(`[ConversationStreamingService] Error executing callback for message ${conversationDetailId}:`, error);
          // Continue with other callbacks even if one fails
        }
      }

    } catch (error) {
      console.error('[ConversationStreamingService] Error routing agent progress:', error);
    }
  }

  /**
   * Route a streaming content chunk (typed block + partial text) to the in-progress
   * message. Accumulates the typed block into the per-message ordered list, then
   * invokes the registered callbacks so the renderer refreshes. The block ride along
   * on the `MessageProgressUpdate` as `block` (in addition to `message` text).
   */
  private async routeStreamingChunk(agentRun: any, streaming: any): Promise<void> {
    const conversationDetailId: string | undefined = agentRun?.ConversationDetailID;
    if (!conversationDetailId) {
      // Without a target we can't route or accumulate — drop silently (the
      // fire-and-forget client subscription handles these when no UI is bound).
      return;
    }

    const block = streaming?.block as AgentStreamBlock | undefined;
    if (block) {
      this.accumulateStreamingBlock(conversationDetailId, block);
    }

    const callbacks = this.callbackRegistry.get(conversationDetailId) || [];
    if (callbacks.length === 0) {
      return;
    }

    const progressUpdate: MessageProgressUpdate = {
      message: streaming?.content ?? '',
      taskName: agentRun?.Agent || 'Agent',
      conversationDetailId,
      metadata: { agentRun } as MessageProgressMetadata,
      resolver: 'RunAIAgentResolver',
      block
    };

    for (const callback of callbacks) {
      try {
        await callback(progressUpdate);
      } catch (error) {
        console.error(`[ConversationStreamingService] Error executing streaming callback for message ${conversationDetailId}:`, error);
      }
    }
  }

  /**
   * Schedule a reconnection attempt after a delay
   */
  private scheduleReconnection(): void {
    if (this.reconnectionTimeout) {
      clearTimeout(this.reconnectionTimeout);
    }

    this.connectionStatus$.next('reconnecting');

    this.reconnectionTimeout = setTimeout(() => {
      console.log('[ConversationStreamingService] Attempting to reconnect...');
      this.initialized = false; // Reset initialization flag
      this.initialize();
    }, 5000);
  }

  /**
   * Get the accumulated, ordered typed content blocks for an in-progress AI message.
   * Returns the live array (callers must not mutate it). Empty when none have arrived.
   * @param conversationDetailId - The in-progress message's ConversationDetailID
   */
  public getStreamingBlocks(conversationDetailId: string): AgentStreamBlock[] {
    return this.streamingBlocks.get(conversationDetailId) || [];
  }

  /**
   * Accumulate one typed block into the ordered list for a message.
   *
   * A `tool-result` block does NOT append — it merges into the most recent
   * `tool-call` with the same CallID, promoting its Status to complete/error and
   * setting Detail from the result/error text. This keeps a tool call rendered as
   * a single evolving row rather than two separate entries. Consecutive `text` /
   * `thinking` deltas are coalesced into the trailing block of the same Kind so
   * the renderer sees a growing message rather than a long list of fragments.
   */
  private accumulateStreamingBlock(conversationDetailId: string, block: AgentStreamBlock): void {
    const blocks = this.streamingBlocks.get(conversationDetailId) || [];

    if (block.Kind === 'tool-result') {
      const target = this.findToolCallForResult(blocks, block.CallID);
      if (target) {
        target.Status = block.Error ? 'error' : 'complete';
        const detail = block.Error ?? block.Result;
        if (detail != null) {
          target.Detail = detail;
        }
        this.streamingBlocks.set(conversationDetailId, blocks);
        return;
      }
      // No matching call seen yet — store as a degenerate completed call so the
      // result isn't silently dropped.
      blocks.push({
        Kind: 'tool-call',
        CallID: block.CallID,
        Name: block.CallID,
        Status: block.Error ? 'error' : 'complete',
        Detail: block.Error ?? block.Result,
      });
      this.streamingBlocks.set(conversationDetailId, blocks);
      return;
    }

    if (block.Kind === 'text' || block.Kind === 'thinking') {
      const last = blocks[blocks.length - 1];
      if (last && last.Kind === block.Kind) {
        last.Content += block.Content;
        this.streamingBlocks.set(conversationDetailId, blocks);
        return;
      }
    }

    // A tool call has a lifecycle: BaseAgent emits a `running` block when it
    // starts, then a `complete`/`error` block with the SAME CallID when it
    // finishes. Update the existing entry in place so it renders as one evolving
    // chip rather than duplicate rows.
    if (block.Kind === 'tool-call') {
      const existing = this.findToolCallForResult(blocks, block.CallID);
      if (existing) {
        existing.Status = block.Status;
        if (block.Label != null) {
          existing.Label = block.Label;
        }
        if (block.Detail != null) {
          existing.Detail = block.Detail;
        }
        if (block.Name) {
          existing.Name = block.Name;
        }
        this.streamingBlocks.set(conversationDetailId, blocks);
        return;
      }
    }

    blocks.push(block);
    this.streamingBlocks.set(conversationDetailId, blocks);
  }

  /** Find the most recent in-flight (or any) tool-call block matching a CallID. */
  private findToolCallForResult(
    blocks: AgentStreamBlock[],
    callId: string
  ): Extract<AgentStreamBlock, { Kind: 'tool-call' }> | undefined {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.Kind === 'tool-call' && b.CallID === callId) {
        return b;
      }
    }
    return undefined;
  }

  /**
   * Clear the accumulated blocks for a message. Called on completion so a fresh
   * run (or the finalized message) starts clean and we don't leak memory.
   */
  public clearStreamingBlocks(conversationDetailId: string): void {
    this.streamingBlocks.delete(conversationDetailId);
  }

  /**
   * Get a recent completion event for a message (used when component initializes after completion)
   * This handles the navigation scenario: user navigates away, agent completes, user returns.
   * @param conversationDetailId - The message ID to check
   * @returns Completion info if found within the last 5 minutes, undefined otherwise
   */
  public getRecentCompletion(conversationDetailId: string): { agentRunId: string } | undefined {
    const completion = this.recentCompletions.get(conversationDetailId);
    return completion ? { agentRunId: completion.agentRunId } : undefined;
  }

  /**
   * Clear a recent completion after it has been handled
   * @param conversationDetailId - The message ID to clear
   */
  public clearRecentCompletion(conversationDetailId: string): void {
    this.recentCompletions.delete(conversationDetailId);
  }

  /**
   * Get a diagnostic snapshot of streaming state for a specific message.
   * Used by the Shift+Click debug tool to dump live in-memory state to the console.
   * @param messageId - The ConversationDetailID to inspect
   */
  public getDiagnosticSnapshot(messageId: string): {
    hasCallbacks: boolean;
    callbackCount: number;
    recentCompletion: { conversationDetailId: string; agentRunId: string; timestamp: Date } | undefined;
    connectionStatus: StreamingConnectionStatus;
  } {
    const callbacks = this.callbackRegistry.get(messageId);
    return {
      hasCallbacks: !!callbacks && callbacks.length > 0,
      callbackCount: callbacks?.length ?? 0,
      recentCompletion: this.recentCompletions.get(messageId),
      connectionStatus: this.connectionStatus$.getValue(),
    };
  }

  /**
   * Cleanup completions older than 5 minutes to prevent memory leak
   */
  private cleanupOldCompletions(): void {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    for (const [id, data] of this.recentCompletions) {
      if (data.timestamp.getTime() < fiveMinutesAgo) {
        this.recentCompletions.delete(id);
      }
    }
  }

  /**
   * Cleanup when service is destroyed
   */
  ngOnDestroy(): void {
    if (this.reconnectionTimeout) {
      clearTimeout(this.reconnectionTimeout);
    }

    if (this.pushStatusSubscription) {
      this.pushStatusSubscription.unsubscribe();
      this.pushStatusSubscription = undefined;
    }

    this.callbackRegistry.clear();
    this.recentCompletions.clear();
    this.streamingBlocks.clear();
    this.completionEvents$.complete();
    this.connectionStatus$.complete();
    this.initialized = false;
  }
}
