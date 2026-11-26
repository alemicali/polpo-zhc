/**
 * The trigger card (an MCP App shown by polpo_trigger_show): the triggers with their endpoint,
 * auth, counts, actions and last delivery; or one trigger with its actions and its recent
 * deliveries (status, reasons, each action's run and what it created, mapped values). Built from the REST shapes; the widget (widgets/trigger-card) draws it, the text
 * is for clients without MCP Apps.
 */
export interface TriggerCardKey { createdAt: number; seq: number }
type Appearance = { light?: Record<string, string>; dark?: Record<string, string> };

export interface TriggerCardSummary {
  id: string; name: string; enabled: boolean; endpoint: string;
  auth: string[];
  contractVersion: number; contentTypes: string[];
  counts: Record<string, number>; total: number;
  lastDeliveryAt?: string; lastStatus?: string;
  /** Something the owner must fix (the HMAC secret is not set…). */
  warning?: string;
  /** Actions that run on an accepted delivery (enabled ones). */
  actionCount: number;
}

/** One action of the trigger, in words. */
export interface TriggerCardAction { id: string; kind: string; label: string; enabled: boolean }

/** One action's run on a delivery. */
export interface TriggerCardActionRun { actionId: string; kind: string; status: string; error?: string; reason?: string; created?: string }

export interface TriggerCardDelivery {
  id: string; receivedAt: string; status: string; httpStatus: number; test?: boolean; reasons: string[]; errors?: string[];
  count?: number; duplicateOf?: string; bytes: number; kind?: string;
  actionsStatus?: string;
  actions?: TriggerCardActionRun[];
}

/** A delivery's action runs as the REST list returns them. */
type RunShape = { actionId: string; kind: string; status: string; error?: string; reason?: string; refs?: { missionId?: string; missionName?: string; taskId?: string; sessionId?: string; notificationId?: string; channel?: string } };

export interface TriggerListCard {
  kind: "triggers";
  key: TriggerCardKey;
  generatedAt: string;
  triggers: TriggerCardSummary[];
  link?: string;
  appearance?: Appearance;
}

export interface TriggerDetailCard {
  kind: "trigger";
  key: TriggerCardKey;
  generatedAt: string;
  trigger: TriggerCardSummary & { description?: string; filter?: string; dedupe?: string; rateLimitPerMinute: number; mapping?: Record<string, string>; actions: TriggerCardAction[] };
  deliveries: TriggerCardDelivery[];
  /** The newest accepted delivery's mapped values: what an action would receive. */
  lastMapped?: Record<string, unknown>;
  link?: string;
  appearance?: Appearance;
}

export type TriggerCard = TriggerListCard | TriggerDetailCard;

/** The REST trigger shape the card reads. */
export interface TriggerShape {
  id: string; name: string; description?: string; enabled: boolean; endpoint: string;
  auth: { secret: boolean; allowQueryToken?: boolean; hmac?: { algorithm: string }; ipAllowlist?: string[] };
  hmacSecret?: { secretSet: boolean };
  contractVersion: number; contract: { contentTypes: string[] };
  filter?: { mode?: string; conditions: Array<{ path: string; op: string; value?: unknown }> };
  dedupe?: { key: string; ttlSeconds: number }; rateLimitPerMinute: number; mapping?: Record<string, string>;
  stats: { counts: Record<string, number>; total: number; lastDeliveryAt?: string; lastStatus?: string };
  actions?: Array<{ id: string; kind: string; enabled: boolean; name?: string; playbook?: string; mission?: string; title?: string; assignTo?: string; agent?: string; channel?: string; deliverTo?: { channel: string; chatId: string; name?: string } }>;
}

/** An action in a few words. */
export function actionLabel(a: NonNullable<TriggerShape["actions"]>[number]): string {
  const what = a.kind === "playbook" ? `Run playbook ${a.playbook}` : a.kind === "mission" ? `Start mission ${a.mission}`
    : a.kind === "task" ? `Task for ${a.assignTo}: ${a.title ?? ""}` : a.kind === "agent" ? `${a.agent ?? "Polpo"} takes a turn${a.deliverTo ? ` → ${a.deliverTo.name ?? a.deliverTo.chatId}` : ""}` : `Notify ${a.channel}`;
  return a.name ? `${a.name} (${what})` : what;
}

const created = (r: RunShape["refs"]): string | undefined => {
  if (!r) return undefined;
  const parts = [r.missionId ? `mission ${r.missionName ?? r.missionId}` : "", r.taskId ? `task ${r.taskId}` : "", r.sessionId ? `chat ${r.sessionId}` : "", r.notificationId ? `notification on ${r.channel}` : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
};

function summary(t: TriggerShape): TriggerCardSummary {
  const auth = [t.auth.secret ? `secret${t.auth.allowQueryToken ? " (+ ?token)" : ""}` : "", t.auth.hmac ? `HMAC ${t.auth.hmac.algorithm}` : "", t.auth.ipAllowlist?.length ? `IP allowlist (${t.auth.ipAllowlist.length})` : ""].filter(Boolean);
  return {
    id: t.id, name: t.name, enabled: t.enabled, endpoint: t.endpoint, auth,
    contractVersion: t.contractVersion, contentTypes: t.contract.contentTypes,
    counts: t.stats.counts, total: t.stats.total,
    ...(t.stats.lastDeliveryAt ? { lastDeliveryAt: t.stats.lastDeliveryAt } : {}), ...(t.stats.lastStatus ? { lastStatus: t.stats.lastStatus } : {}),
    ...(t.auth.hmac && t.hmacSecret && !t.hmacSecret.secretSet ? { warning: "The HMAC signing secret is not set: every delivery is refused" } : {}),
    actionCount: (t.actions ?? []).filter((a) => a.enabled).length,
  };
}

export function buildTriggerListCard(o: { triggers: TriggerShape[]; key: TriggerCardKey; link?: string }): TriggerListCard {
  return { kind: "triggers", key: o.key, generatedAt: new Date().toISOString(), triggers: o.triggers.map(summary), ...(o.link ? { link: o.link } : {}) };
}

export function buildTriggerDetailCard(o: { trigger: TriggerShape; deliveries: Array<Omit<TriggerCardDelivery, "actions"> & { actions?: RunShape[] }>; lastMapped?: Record<string, unknown>; key: TriggerCardKey; link?: string }): TriggerDetailCard {
  const t = o.trigger;
  return {
    kind: "trigger", key: o.key, generatedAt: new Date().toISOString(),
    trigger: {
      ...summary(t), ...(t.description ? { description: t.description } : {}),
      ...(t.filter?.conditions.length ? { filter: `${t.filter.mode === "any" ? "any of" : "all of"}: ${t.filter.conditions.map((c) => `${c.path} ${c.op}${c.value !== undefined ? ` ${JSON.stringify(c.value)}` : ""}`).join("; ")}` } : {}),
      ...(t.dedupe ? { dedupe: `${t.dedupe.key} · ${t.dedupe.ttlSeconds}s` } : {}),
      rateLimitPerMinute: t.rateLimitPerMinute, ...(t.mapping ? { mapping: t.mapping } : {}),
      actions: (t.actions ?? []).map((a) => ({ id: a.id, kind: a.kind, label: actionLabel(a), enabled: a.enabled })),
    },
    deliveries: o.deliveries.map((d) => ({
      id: d.id, receivedAt: d.receivedAt, status: d.status, httpStatus: d.httpStatus, reasons: d.reasons, bytes: d.bytes,
      ...(d.test ? { test: true } : {}), ...(d.errors?.length ? { errors: d.errors.slice(0, 5) } : {}), ...(d.count ? { count: d.count } : {}),
      ...(d.duplicateOf ? { duplicateOf: d.duplicateOf } : {}), ...(d.kind ? { kind: d.kind } : {}),
      ...(d.actionsStatus ? { actionsStatus: d.actionsStatus } : {}),
      ...(d.actions?.length ? { actions: d.actions.map((r) => ({
        actionId: r.actionId, kind: r.kind, status: r.status, ...(r.error ? { error: r.error } : {}), ...(r.reason ? { reason: r.reason } : {}),
        ...(created(r.refs) ? { created: created(r.refs) } : {}),
      })) } : {}),
    })),
    ...(o.lastMapped ? { lastMapped: o.lastMapped } : {}),
    ...(o.link ? { link: o.link } : {}),
  };
}

const at = (iso?: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "");
const counts = (c: Record<string, number>) => `${c.accepted ?? 0} accepted, ${c.rejected ?? 0} rejected, ${c.filtered ?? 0} filtered, ${c.duplicate ?? 0} duplicate${c.rate_limited ? `, ${c.rate_limited} rate limited` : ""}`;

/** The card as text (clients without MCP Apps). */
export function triggerCardText(card: TriggerCard): string {
  if (card.kind === "triggers") {
    if (!card.triggers.length) return "No triggers yet (polpo_trigger_create).";
    return card.triggers.map((t) => `- ${t.name} [${t.id}]${t.enabled ? "" : " (disabled)"} · ${t.endpoint} · ${t.auth.join(" + ")} · ${t.total} deliveries (${counts(t.counts)})`
      + ` · ${t.actionCount ? `${t.actionCount} action${t.actionCount > 1 ? "s" : ""}` : "no actions"}`
      + `${t.lastDeliveryAt ? ` · last ${at(t.lastDeliveryAt)} ${t.lastStatus}` : ""}${t.warning ? ` · ⚠ ${t.warning}` : ""}`).join("\n");
  }
  const t = card.trigger;
  return [
    `${t.name} [${t.id}]${t.enabled ? "" : " (disabled)"} · ${t.endpoint}`,
    `auth ${t.auth.join(" + ")} · contract v${t.contractVersion} (${t.contentTypes.join(", ")}) · ${t.rateLimitPerMinute}/min${t.warning ? ` · ⚠ ${t.warning}` : ""}`,
    t.filter ? `filter: ${t.filter}` : "", t.dedupe ? `dedupe: ${t.dedupe}` : "",
    t.mapping ? `mapping: ${Object.entries(t.mapping).map(([k, v]) => `${k} ← ${v}`).join(", ")}` : "",
    t.actions.length ? `actions: ${t.actions.map((a, i) => `${i + 1}. ${a.label}${a.enabled ? "" : " (disabled)"}`).join("; ")}` : "no actions (deliveries are only recorded)",
    `${t.total} deliveries (${counts(t.counts)})`,
    ...card.deliveries.map((d) => `- ${at(d.receivedAt)} ${d.status}${d.test ? " (test)" : ""} HTTP ${d.httpStatus} ${d.id}${d.count && d.count > 1 ? ` ×${d.count}` : ""}${d.reasons.length ? ` · ${d.reasons.join("; ")}` : ""}`
      + `${d.actionsStatus ? ` · actions ${d.actionsStatus}${d.actions?.length ? ` (${d.actions.map((r) => `${r.actionId} ${r.status}${r.created ? ` → ${r.created}` : ""}${r.error ? `: ${r.error}` : ""}`).join("; ")})` : ""}` : ""}`),
    card.lastMapped ? `last mapped values: ${JSON.stringify(card.lastMapped)}` : "",
  ].filter(Boolean).join("\n");
}
