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

    const es = new EventSource(url);
    this.es = es;

    es.onopen = () => {
      this.currentDelay = this.initialDelay;
      this.setStatus("connected");
    };

    es.onmessage = (e) => {
      this.handleMessage(e);
    };

    // Listen for named events (Polpo sends typed event names)
    // EventSource API: use addEventListener for named events
    es.addEventListener("task:created", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("task:transition", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("task:updated", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("task:removed", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("task:retry", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("task:fix", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("task:maxRetries", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("task:question", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("task:answered", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("task:timeout", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("task:recovered", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("agent:spawned", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("agent:finished", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("agent:activity", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("agent:stale", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("assessment:started", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("assessment:progress", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("assessment:complete", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("assessment:corrected", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("orchestrator:started", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("orchestrator:tick", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("orchestrator:deadlock", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("orchestrator:shutdown", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("deadlock:detected", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("deadlock:resolving", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("deadlock:resolved", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("deadlock:unresolvable", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("plan:saved", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("plan:executed", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("plan:completed", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("plan:resumed", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("plan:deleted", (e) => this.handleMessage(e as MessageEvent));
    es.addEventListener("log", (e) => this.handleMessage(e as MessageEvent));

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
