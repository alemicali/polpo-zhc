import { nanoid } from "nanoid";
import type { TypedEmitter, OrchestraEvent, OrchestraEventMap } from "../core/events.js";
import type { NotificationsConfig, NotificationRule, NotificationChannelConfig } from "../core/types.js";
import type { NotificationChannel, Notification } from "./types.js";
import { defaultTitle, defaultBody, applyTemplate } from "./templates.js";
import { SlackChannel } from "./channels/slack.js";
import { TelegramChannel } from "./channels/telegram.js";
import { EmailChannel } from "./channels/email.js";
import { WebhookChannel } from "./channels/webhook.js";

export type { NotificationChannel, Notification } from "./types.js";

/**
 * Event-driven notification router.
 *
 * Subscribes to OrchestraEventMap events, matches them against configured rules,
 * and dispatches notifications to the appropriate channels.
 *
 * Features:
 * - Glob-style event pattern matching ("task:*", "plan:completed")
 * - Optional condition filters on event payloads
 * - Per-rule cooldown/throttling
 * - Pluggable channel adapters (Slack, Telegram, Email, Webhook)
 */
export class NotificationRouter {
  private channels = new Map<string, NotificationChannel>();
  private rules: NotificationRule[] = [];
  private cooldowns = new Map<string, number>(); // ruleId → last dispatch timestamp
  private listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  constructor(private emitter: TypedEmitter) {}

  /**
   * Initialize from configuration.
   * Creates channel instances and registers rules.
   */
  init(config: NotificationsConfig): void {
    // Create channel instances
    for (const [id, channelConfig] of Object.entries(config.channels)) {
      try {
        const channel = this.createChannel(channelConfig);
        this.channels.set(id, channel);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emitter.emit("log", {
          level: "warn",
          message: `[notifications] Failed to create channel "${id}": ${msg}`,
        });
      }
    }

    // Register rules
    this.rules = config.rules;
  }

  /**
   * Start listening to orchestrator events.
   * Subscribes to all unique event patterns from the configured rules.
   */
  start(): void {
    // Collect all unique event patterns
    const patterns = new Set<string>();
    for (const rule of this.rules) {
      for (const pattern of rule.events) {
        patterns.add(pattern);
      }
    }

    // Subscribe to matching events
    const allEvents = getAllEventNames();
    const subscribedEvents = new Set<string>();

    for (const pattern of patterns) {
      for (const event of allEvents) {
        if (matchGlob(pattern, event) && !subscribedEvents.has(event)) {
          subscribedEvents.add(event);
          const fn = (data: unknown) => this.handleEvent(event, data);
          this.emitter.on(event as OrchestraEvent, fn as (payload: OrchestraEventMap[OrchestraEvent]) => void);
          this.listeners.push({ event, fn });
        }
      }
    }
  }

  /**
   * Handle an incoming event — match against rules and dispatch notifications.
   */
  private handleEvent(event: string, data: unknown): void {
    for (const rule of this.rules) {
      // Check if event matches any of the rule's patterns
      const matches = rule.events.some(pattern => matchGlob(pattern, event));
      if (!matches) continue;

      // Check optional condition
      if (rule.condition) {
        try {
          const fn = new Function("data", `try { return !!(${rule.condition}); } catch { return false; }`);
          if (!fn(data)) continue;
        } catch {
          continue;
        }
      }

      // Check cooldown
      if (rule.cooldownMs) {
        const lastDispatch = this.cooldowns.get(rule.id);
        if (lastDispatch && Date.now() - lastDispatch < rule.cooldownMs) {
          continue; // Still in cooldown period
        }
      }

      // Dispatch to all configured channels
      this.cooldowns.set(rule.id, Date.now());
      this.dispatch(rule, event, data);
    }
  }

  /**
   * Dispatch a notification to all channels specified by a rule.
   */
  private dispatch(rule: NotificationRule, event: string, data: unknown): void {
    const severity = rule.severity ?? "info";
    const templateCtx = { event, data, severity };

    const title = rule.template
      ? applyTemplate(rule.template, data)
      : defaultTitle(templateCtx);

    const body = rule.template
      ? applyTemplate(rule.template, data)
      : defaultBody(templateCtx);

    for (const channelId of rule.channels) {
      const channel = this.channels.get(channelId);
      if (!channel) {
        this.emitter.emit("log", {
          level: "warn",
          message: `[notifications] Channel "${channelId}" not found for rule "${rule.name}"`,
        });
        continue;
      }

      const notification: Notification = {
        id: nanoid(),
        channel: channelId,
        title,
        body,
        severity,
        sourceEvent: event,
        sourceData: data,
        ruleId: rule.id,
        timestamp: new Date().toISOString(),
      };

      channel.send(notification).then(() => {
        this.emitter.emit("notification:sent", {
          ruleId: rule.id,
          channel: channelId,
          event,
        });
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.emitter.emit("notification:failed", {
          ruleId: rule.id,
          channel: channelId,
          error: msg,
        });
      });
    }
  }

  /**
   * Test all configured channels. Returns results per channel.
   */
  async testChannels(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    for (const [id, channel] of this.channels) {
      try {
        results[id] = await channel.test();
      } catch {
        results[id] = false;
      }
    }
    return results;
  }

  /**
   * Register a custom channel programmatically.
   */
  registerChannel(id: string, channel: NotificationChannel): void {
    this.channels.set(id, channel);
  }

  /**
   * Add a notification rule programmatically.
   */
  addRule(rule: NotificationRule): void {
    this.rules.push(rule);
  }

  /**
   * Get currently configured rules (for API/TUI display).
   */
  getRules(): NotificationRule[] {
    return [...this.rules];
  }

  /**
   * Get configured channel IDs.
   */
  getChannelIds(): string[] {
    return [...this.channels.keys()];
  }

  /**
   * Cleanup: remove all event listeners.
   */
  dispose(): void {
    for (const { event, fn } of this.listeners) {
      this.emitter.off(event as OrchestraEvent, fn as (payload: OrchestraEventMap[OrchestraEvent]) => void);
    }
    this.listeners.length = 0;
  }

  /**
   * Create a channel instance from config.
   */
  private createChannel(config: NotificationChannelConfig): NotificationChannel {
    switch (config.type) {
      case "slack":
        return new SlackChannel(config);
      case "telegram":
        return new TelegramChannel(config);
      case "email":
        return new EmailChannel(config);
      case "webhook":
        return new WebhookChannel(config);
      default:
        throw new Error(`Unknown channel type: ${config.type}`);
    }
  }
}

// ─── Utilities ──────────────────────────────────────

/**
 * Simple glob matcher for event names.
 * Supports "*" as single-segment wildcard and "**" as multi-segment.
 *
 * Examples:
 *   "task:*" matches "task:created", "task:transition", etc.
 *   "task:created" matches only "task:created"
 *   "*:*" matches all two-segment events
 */
function matchGlob(pattern: string, event: string): boolean {
  if (pattern === event) return true;
  if (pattern === "*") return true;

  // Convert glob to regex
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")  // Escape regex specials
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^:]*")
    .replace(/__GLOBSTAR__/g, ".*");

  try {
    return new RegExp(`^${regexStr}$`).test(event);
  } catch {
    return false;
  }
}

/**
 * Get all known event names from the OrchestraEventMap.
 * Used to subscribe to concrete events matching glob patterns.
 */
function getAllEventNames(): string[] {
  return [
    // Task lifecycle
    "task:created", "task:transition", "task:updated", "task:removed",
    // Agent lifecycle
    "agent:spawned", "agent:finished", "agent:activity",
    // Assessment
    "assessment:started", "assessment:progress", "assessment:complete", "assessment:corrected",
    // Orchestrator lifecycle
    "orchestrator:started", "orchestrator:tick", "orchestrator:deadlock", "orchestrator:shutdown",
    // Retry & Fix
    "task:retry", "task:fix", "task:maxRetries",
    // Question detection
    "task:question", "task:answered",
    // Deadlock resolution
    "deadlock:detected", "deadlock:resolving", "deadlock:resolved", "deadlock:unresolvable",
    // Resilience
    "task:timeout", "agent:stale",
    // Recovery
    "task:recovered",
    // Plans
    "plan:saved", "plan:executed", "plan:completed", "plan:resumed", "plan:deleted",
    // Chat sessions
    "session:created", "message:added",
    // Approval gates
    "approval:requested", "approval:resolved", "approval:timeout",
    // Escalation
    "escalation:triggered", "escalation:resolved", "escalation:human",
    // Notifications
    "notification:sent", "notification:failed",
    // General
    "log",
  ];
}
