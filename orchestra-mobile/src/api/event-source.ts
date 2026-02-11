/**
 * Polpo Mobile - Server-Sent Events (SSE) Client
 * React Native-compatible EventSource implementation using XMLHttpRequest
 *
 * Note: React Native doesn't have native EventSource support, so we use
 * XMLHttpRequest which is available via the JavaScript runtime.
 */

import type { SSEEvent, ConnectionStatus, OrchestraEventType } from './types';

export interface EventSourceConfig {
  url: string;
  apiKey?: string;
  onEvent: (event: SSEEvent) => void;
  onStatusChange: (status: ConnectionStatus) => void;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
}

/**
 * React Native-compatible SSE client using XMLHttpRequest
 * Supports automatic reconnection with exponential backoff
 */
export class EventSourceManager {
  private xhr: XMLHttpRequest | null = null;
  private lastEventId: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentDelay: number;
  private status: ConnectionStatus = 'disconnected';
  private disposed = false;
  private buffer = '';

  private readonly config: EventSourceConfig;
  private readonly maxDelay: number;
  private readonly initialDelay: number;

  constructor(config: EventSourceConfig) {
    this.config = config;
    this.initialDelay = config.reconnectDelay ?? 1000;
    this.maxDelay = config.maxReconnectDelay ?? 30000;
    this.currentDelay = this.initialDelay;
  }

  /**
   * Establish SSE connection using XMLHttpRequest
   * - Supports Last-Event-ID for resuming missed events
   * - Handles incremental data via onprogress (streaming)
   * - Auto-reconnects with exponential backoff on errors
   */
  connect(): void {
    if (this.disposed) return;
    this.cleanup();
    this.setStatus('connecting');

    let url = this.config.url;

    // Add lastEventId for reconnection (Polpo server resends missed events)
    if (this.lastEventId) {
      const sep = url.includes('?') ? '&' : '?';
      url += `${sep}lastEventId=${encodeURIComponent(this.lastEventId)}`;
    }

    // Add API key as query param (EventSource can't set custom headers)
    if (this.config.apiKey) {
      const sep = url.includes('?') ? '&' : '?';
      url += `${sep}apiKey=${encodeURIComponent(this.config.apiKey)}`;
    }

    const xhr = new XMLHttpRequest();
    this.xhr = xhr;
    this.buffer = '';

    xhr.open('GET', url, true);
    xhr.setRequestHeader('Accept', 'text/event-stream');
    xhr.setRequestHeader('Cache-Control', 'no-cache');

    // Track how much of responseText we've already processed
    let progressOffset = 0;

    // onprogress fires as data arrives (streaming)
    xhr.onprogress = () => {
      if (xhr.readyState === 3 || xhr.readyState === 4) {
        // Extract only the new chunk since last progress event
        const chunk = xhr.responseText.substring(progressOffset);
        progressOffset = xhr.responseText.length;

        if (chunk) {
          this.buffer += chunk;
          this.processBuffer();
        }
      }
    };

    xhr.onreadystatechange = () => {
      if (xhr.readyState === 2) {
        // Headers received - check if connection successful
        if (xhr.status === 200) {
          // Reset backoff delay on successful connection
          this.currentDelay = this.initialDelay;
          this.setStatus('connected');
        }
      } else if (xhr.readyState === 4) {
        // Request complete (connection closed)
        if (xhr.status !== 200) {
          this.scheduleReconnect();
        }
      }
    };

    xhr.onerror = () => {
      this.scheduleReconnect();
    };

    xhr.ontimeout = () => {
      this.scheduleReconnect();
    };

    xhr.send();
  }

  disconnect(): void {
    this.disposed = true;
    this.cleanup();
    this.setStatus('disconnected');
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Process SSE buffer according to the SSE specification
   * - Lines are delimited by \n
   * - Empty line triggers event dispatch
   * - Lines starting with : are comments
   * - Format: field:value (with optional leading space after colon)
   */
  private processBuffer(): void {
    const lines = this.buffer.split('\n');

    // Keep the last incomplete line in the buffer (may be partial)
    this.buffer = lines.pop() || '';

    let currentEvent: Partial<SSEEvent> = {};

    for (const line of lines) {
      if (line === '') {
        // Empty line = dispatch event (SSE spec)
        if (currentEvent.data !== undefined) {
          this.dispatchEvent(currentEvent as SSEEvent);
        }
        currentEvent = {};
      } else if (line.startsWith(':')) {
        // Comment - ignore (used for keepalive pings)
        continue;
      } else {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) continue;

        const field = line.substring(0, colonIndex);
        let value = line.substring(colonIndex + 1);

        // Remove leading space if present (SSE spec)
        if (value.startsWith(' ')) {
          value = value.substring(1);
        }

        switch (field) {
          case 'id':
            currentEvent.id = value;
            this.lastEventId = value; // Store for reconnection
            break;
          case 'event':
            currentEvent.event = value;
            break;
          case 'data':
            // Data can span multiple lines
            if (currentEvent.data === undefined) {
              currentEvent.data = value;
            } else {
              currentEvent.data += '\n' + value;
            }
            break;
          case 'retry':
            // Server can suggest reconnect delay (milliseconds)
            const retry = parseInt(value, 10);
            if (!isNaN(retry)) {
              this.currentDelay = retry;
            }
            break;
        }
      }
    }
  }

  private dispatchEvent(rawEvent: SSEEvent): void {
    let data: unknown;
    try {
      data = JSON.parse(rawEvent.data as string);
    } catch {
      data = rawEvent.data;
    }

    const event: SSEEvent = {
      id: rawEvent.id || '',
      event: rawEvent.event || 'message',
      data,
      timestamp: new Date().toISOString(),
    };

    this.config.onEvent(event);
  }

  /**
   * Schedule reconnection with exponential backoff
   * - Starts at initialDelay (default 1s)
   * - Doubles delay on each retry
   * - Caps at maxDelay (default 30s)
   */
  private scheduleReconnect(): void {
    this.cleanup();
    if (this.disposed) return;

    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      // Exponential backoff: 1s -> 2s -> 4s -> 8s -> 16s -> 30s (capped)
      this.currentDelay = Math.min(this.currentDelay * 2, this.maxDelay);
      this.connect();
    }, this.currentDelay);
  }

  private cleanup(): void {
    if (this.xhr) {
      this.xhr.abort();
      this.xhr = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.buffer = '';
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.config.onStatusChange(status);
    }
  }
}

/**
 * Helper to get human-readable connection status
 */
export function getConnectionStatusLabel(status: ConnectionStatus): string {
  switch (status) {
    case 'connecting':
      return 'Connecting...';
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Reconnecting...';
    case 'disconnected':
      return 'Disconnected';
    case 'error':
      return 'Connection Error';
    default:
      return 'Unknown';
  }
}

/**
 * All Polpo event types for reference
 */
export const ALL_ORCHESTRA_EVENTS: OrchestraEventType[] = [
  'task:created',
  'task:transition',
  'task:updated',
  'task:removed',
  'task:retry',
  'task:fix',
  'task:maxRetries',
  'task:question',
  'task:answered',
  'task:timeout',
  'task:recovered',
  'agent:spawned',
  'agent:finished',
  'agent:activity',
  'agent:stale',
  'assessment:started',
  'assessment:progress',
  'assessment:complete',
  'assessment:corrected',
  'orchestrator:started',
  'orchestrator:tick',
  'orchestrator:deadlock',
  'orchestrator:shutdown',
  'deadlock:detected',
  'deadlock:resolving',
  'deadlock:resolved',
  'deadlock:unresolvable',
  'plan:saved',
  'plan:executed',
  'plan:completed',
  'plan:resumed',
  'plan:deleted',
  'log',
];
