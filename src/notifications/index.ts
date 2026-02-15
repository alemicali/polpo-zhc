import { nanoid } from "nanoid";
import { readFileSync, existsSync, statSync } from "node:fs";
import type { TypedEmitter, PolpoEvent, PolpoEventMap } from "../core/events.js";
import type { NotificationsConfig, NotificationRule, NotificationChannelConfig, NotificationCondition, TaskOutcome, OutcomeType } from "../core/types.js";
import type { NotificationChannel, Notification, OutcomeAttachment } from "./types.js";
import type { NotificationStore, NotificationRecord } from "../core/notification-store.js";
import { defaultTitle, defaultBody, applyTemplate } from "./templates.js";
import { SlackChannel } from "./channels/slack.js";
import { TelegramChannel } from "./channels/telegram.js";
import { EmailChannel } from "./channels/email.js";
import { WebhookChannel } from "./channels/webhook.js";

export type { NotificationChannel, Notification, OutcomeAttachment } from "./types.js";
export type { NotificationStore, NotificationRecord, NotificationStatus } from "../core/notification-store.js";

/**
 * Event-driven notification router.
 *
 * Subscribes to PolpoEventMap events, matches them against configured rules,
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
  /** Track which concrete events we're already subscribed to (avoid duplicate listeners) */
  private subscribedEvents = new Set<string>();
  private started = false;
  /** Optional persistent store for notification history. */
  private store?: NotificationStore;

  constructor(private emitter: TypedEmitter) {}

  /** Set the notification store for persisting notification history. */
  setStore(store: NotificationStore): void {
    this.store = store;
  }

  /** Get the notification store (if configured). */
  getStore(): NotificationStore | undefined {
    return this.store;
  }

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
    this.started = true;

    // Collect all unique event patterns
    const patterns = new Set<string>();
    for (const rule of this.rules) {
      for (const pattern of rule.events) {
        patterns.add(pattern);
      }
    }

    // Subscribe to matching events
    this.subscribePatterns(patterns);
  }

  /**
   * Subscribe to concrete events matching the given glob patterns.
   * Skips events that are already subscribed to (idempotent).
   */
  private subscribePatterns(patterns: Iterable<string>): void {
    const allEvents = getAllEventNames();

    for (const pattern of patterns) {
      for (const event of allEvents) {
        if (matchGlob(pattern, event) && !this.subscribedEvents.has(event)) {
          this.subscribedEvents.add(event);
          const fn = (data: unknown) => this.handleEvent(event, data);
          this.emitter.on(event as PolpoEvent, fn as (payload: PolpoEventMap[PolpoEvent]) => void);
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

      // Check optional JSON condition (pure data — no eval)
      if (rule.condition) {
        try {
          if (!evaluateCondition(rule.condition, data)) continue;
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

    // Prepare outcome attachments if the rule requests them
    const attachments = rule.includeOutcomes
      ? this.loadAttachments(data, rule.outcomeFilter, rule.maxAttachmentSize)
      : [];

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

      // Use sendWithAttachments if channel supports it and we have attachments
      const sendPromise = (attachments.length > 0 && channel.sendWithAttachments)
        ? channel.sendWithAttachments(notification, attachments)
        : channel.send(notification);

      sendPromise.then(() => {
        this.emitter.emit("notification:sent", {
          ruleId: rule.id,
          channel: channelId,
          event,
        });
        // Persist successful notification
        this.persist(notification, rule, channel.type, "sent", attachments.length, attachments);
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.emitter.emit("notification:failed", {
          ruleId: rule.id,
          channel: channelId,
          error: msg,
        });
        // Persist failed notification
        this.persist(notification, rule, channel.type, "failed", attachments.length, attachments, msg);
      });
    }
  }

  /** Persist a notification record to the store (if configured). */
  private persist(
    notification: Notification,
    rule: NotificationRule,
    channelType: string,
    status: "sent" | "failed",
    attachmentCount: number,
    attachments: OutcomeAttachment[],
    error?: string,
  ): void {
    if (!this.store) return;
    try {
      const record: NotificationRecord = {
        id: notification.id,
        timestamp: notification.timestamp,
        ruleId: rule.id,
        ruleName: rule.name,
        channel: notification.channel,
        channelType,
        status,
        error,
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
        sourceEvent: notification.sourceEvent,
        attachmentCount,
        attachmentTypes: attachmentCount > 0
          ? [...new Set(attachments.map(a => a.type))]
          : undefined,
      };
      this.store.append(record);
    } catch {
      // Best-effort — don't break notification flow if store write fails
    }
  }

  /**
   * Load outcome attachments from the event data.
   * Looks for outcomes in common event payload shapes:
   *   - task:transition / task:created → data.task.outcomes
   *   - plan:completed → data.report.outcomes
   *   - Direct outcomes array on data
   */
  private loadAttachments(
    data: unknown,
    typeFilter?: OutcomeType[],
    maxSize?: number,
  ): OutcomeAttachment[] {
    const maxBytes = maxSize ?? 10 * 1024 * 1024; // default 10MB
    const outcomes = extractOutcomes(data);
    if (outcomes.length === 0) return [];

    const attachments: OutcomeAttachment[] = [];
    for (const outcome of outcomes) {
      // Apply type filter
      if (typeFilter && typeFilter.length > 0 && !typeFilter.includes(outcome.type)) continue;

      const att: OutcomeAttachment = {
        label: outcome.label,
        type: outcome.type,
        mimeType: outcome.mimeType,
        text: outcome.text,
        url: outcome.url,
      };

      // Load file content for file/media outcomes
      if (outcome.path) {
        try {
          if (!existsSync(outcome.path)) continue; // skip missing files
          const stat = statSync(outcome.path);
          if (stat.size > maxBytes) continue; // skip files that are too large
          att.filePath = outcome.path;
          att.size = stat.size;
          att.content = readFileSync(outcome.path);
        } catch {
          continue; // skip unreadable files
        }
      }

      // For text/json/url outcomes without a file, include the text directly
      if (!att.content && !att.text && outcome.data) {
        att.text = JSON.stringify(outcome.data, null, 2);
      }

      attachments.push(att);
    }

    return attachments;
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
   * If the router is already started, also subscribes to any new event patterns.
   */
  addRule(rule: NotificationRule): void {
    this.rules.push(rule);

    // If already started, subscribe to events for this new rule
    if (this.started) {
      this.subscribePatterns(rule.events);
    }
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
      this.emitter.off(event as PolpoEvent, fn as (payload: PolpoEventMap[PolpoEvent]) => void);
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
 * Get all known event names from the PolpoEventMap.
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
    // SLA & Deadlines
    "sla:warning", "sla:violated", "sla:met",
    // Quality gates (plan-level)
    "quality:gate:passed", "quality:gate:failed", "quality:threshold:failed",
    // Scheduling
    "schedule:triggered", "schedule:created", "schedule:completed",
    // Notifications
    "notification:sent", "notification:failed",
    // General
    "log",
  ];
}

/**
 * Extract TaskOutcome[] from an event payload.
 * Supports multiple event shapes:
 *   - { task: { outcomes: [...] } }              — task:transition, task:created
 *   - { report: { outcomes: [...] } }            — plan:completed
 *   - { report: { tasks: [{ outcomes: [...] }] } } — plan:completed (per-task)
 *   - { outcomes: [...] }                        — direct
 */
function extractOutcomes(data: unknown): TaskOutcome[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;

  // Direct outcomes array on the payload
  if (Array.isArray(d.outcomes) && d.outcomes.length > 0) {
    return d.outcomes as TaskOutcome[];
  }

  // task.outcomes (task lifecycle events)
  if (d.task && typeof d.task === "object") {
    const task = d.task as Record<string, unknown>;
    if (Array.isArray(task.outcomes) && task.outcomes.length > 0) {
      return task.outcomes as TaskOutcome[];
    }
  }

  // report.outcomes (plan:completed aggregated outcomes)
  if (d.report && typeof d.report === "object") {
    const report = d.report as Record<string, unknown>;
    if (Array.isArray(report.outcomes) && report.outcomes.length > 0) {
      return report.outcomes as TaskOutcome[];
    }
    // Fall back to per-task outcomes within the report
    if (Array.isArray(report.tasks)) {
      const outcomes: TaskOutcome[] = [];
      for (const t of report.tasks) {
        if (t && typeof t === "object" && Array.isArray((t as Record<string, unknown>).outcomes)) {
          outcomes.push(...(t as Record<string, unknown>).outcomes as TaskOutcome[]);
        }
      }
      if (outcomes.length > 0) return outcomes;
    }
  }

  return [];
}

// ─── JSON Condition Evaluator ───────────────────────
//
// Pure-data condition evaluator for notification rules.
// No eval(), no new Function(), no string parsing.
//
// Conditions are JSON objects:
//   { "field": "status", "op": "==", "value": "failed" }
//   { "and": [ { "field": "status", "op": "==", "value": "failed" }, { "field": "retries", "op": ">", "value": 3 } ] }
//   { "or": [ ... ] }
//   { "not": { "field": "status", "op": "==", "value": "done" } }
//   { "field": "error", "op": "exists" }

/** Evaluate a JSON condition against event data. Returns boolean. */
function evaluateCondition(condition: NotificationCondition, data: unknown): boolean {
  // Logical combinators
  if ("and" in condition) {
    return condition.and.every(c => evaluateCondition(c, data));
  }
  if ("or" in condition) {
    return condition.or.some(c => evaluateCondition(c, data));
  }
  if ("not" in condition) {
    return !evaluateCondition(condition.not, data);
  }

  // Single comparison
  const fieldValue = resolvePath(condition.field, data);

  switch (condition.op) {
    case "exists":
      return fieldValue !== undefined && fieldValue !== null;
    case "not_exists":
      return fieldValue === undefined || fieldValue === null;
    case "==":
      return fieldValue == condition.value;
    case "!=":
      return fieldValue != condition.value;
    case ">":
      return (fieldValue as number) > (condition.value as number);
    case ">=":
      return (fieldValue as number) >= (condition.value as number);
    case "<":
      return (fieldValue as number) < (condition.value as number);
    case "<=":
      return (fieldValue as number) <= (condition.value as number);
    case "includes":
      if (typeof fieldValue === "string") return fieldValue.includes(String(condition.value));
      if (Array.isArray(fieldValue)) return fieldValue.includes(condition.value);
      return false;
    case "not_includes":
      if (typeof fieldValue === "string") return !fieldValue.includes(String(condition.value));
      if (Array.isArray(fieldValue)) return !fieldValue.includes(condition.value);
      return true;
    default:
      return false;
  }
}

/** Resolve a dotted property path (e.g. "task.status") on the data object. */
function resolvePath(path: string, data: unknown): unknown {
  const parts = path.split(/[.[\]]+/).filter(Boolean);
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
