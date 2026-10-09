import { POLPO_EVENT_NAMES } from "./event-names.js";
import type { SSEEvent } from "./types.js";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export interface EventSourceConfig {
  url: string;
  onEvent: (event: SSEEvent) => void;
  onStatusChange: (status: ConnectionStatus) => void;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
}

export class EventSourceManager {
  private es: EventSource | null = null;
  private lastEventId: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentDelay: number;
  private status: ConnectionStatus = "disconnected";
  private disposed = false;

  private readonly config: EventSourceConfig;
  private readonly maxDelay: number;
  private readonly initialDelay: number;

  constructor(config: EventSourceConfig) {
    this.config = config;
    this.initialDelay = config.reconnectDelay ?? 1000;
    this.maxDelay = config.maxReconnectDelay ?? 30000;
    this.currentDelay = this.initialDelay;
  }

  connect(): void {
    if (this.disposed) return;
    this.cleanup();
    this.setStatus("connecting");

    let url = this.config.url;
    if (this.lastEventId) {
      const sep = url.includes("?") ? "&" : "?";
      url += `${sep}lastEventId=${encodeURIComponent(this.lastEventId)}`;
    }

    const es = new EventSource(url, { withCredentials: true });
    this.es = es;

    es.onopen = () => {
      this.currentDelay = this.initialDelay;
      this.setStatus("connected");
    };

    es.onmessage = (e) => {
      this.handleMessage(e);
    };

    // Listen for named events (Polpo sends typed event names): the whole bus
    for (const name of POLPO_EVENT_NAMES) {
      es.addEventListener(name, (e) => this.handleMessage(e as MessageEvent));
    }

    es.onerror = () => {
      this.scheduleReconnect();
    };
  }

  disconnect(): void {
    this.disposed = true;
    this.cleanup();
    this.setStatus("disconnected");
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  private handleMessage(e: MessageEvent): void {
    if (e.lastEventId) {
      this.lastEventId = e.lastEventId;
    }

    let data: unknown;
    try {
      data = JSON.parse(e.data as string);
    } catch {
      data = e.data;
    }

    const event: SSEEvent = {
      id: e.lastEventId ?? "",
      event: e.type === "message" ? "message" : e.type,
      data,
      timestamp: new Date().toISOString(),
    };

    this.config.onEvent(event);
  }

  private scheduleReconnect(): void {
    this.cleanup();
    if (this.disposed) return;

    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.currentDelay = Math.min(this.currentDelay * 2, this.maxDelay);
      this.connect();
    }, this.currentDelay);
  }

  private cleanup(): void {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.config.onStatusChange(status);
    }
  }
}
