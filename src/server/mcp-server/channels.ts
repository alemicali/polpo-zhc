/**
 * Channels: where the instance talks to people (notification channels, Telegram bots and the chats
 * they reach, WhatsApp, email, Slack, WhatsApp Business, webhooks, push), sending a message or a file
 * now, the notification history and the notification rules. The
 * vault: which credentials each agent has (names and metadata, never values).
 *
 * Secrets never pass through here: bot tokens, SMTP passwords and API keys are entered in the
 * dashboard (setup_url). Changing the notification rules needs polpo:admin; sending a message (or a
 * test) polpo:messages, and confirm: true; the vault, reads too, polpo:vault.
 */
import { z } from "zod";
import {
  BAD_CURSOR, DESTRUCTIVE, READ, UPDATE, apiError, apiGet, apiSend, confirmParam, cursorParam, dashboardLink, enc, fail, limitParam, looseObject, ok,
  page, pageOutput, qs, short,
  type McpDeps, type Register,
} from "./kit.js";
import { unknownAgents } from "./tasks.js";

type Rule = { id: string; name?: string; events: string[]; channels: string[]; severity?: string; template?: string; cooldownMs?: number };

const channelItem = z.object({ name: z.string(), type: z.string() });
/** Every channel polpo_message_send can send on. */
const SEND_CHANNELS = ["telegram", "whatsapp", "email", "slack", "whatsapp-business", "webhook", "push", "expo-push"] as const;
/** The ones sent through the notification router (POST /notifications/send), by configured channel name. */
const ROUTER_CHANNELS = ["slack", "whatsapp-business", "webhook", "push", "expo-push"] as const;
const ruleItem = z.object({ id: z.string(), name: z.string().optional(), events: z.array(z.string()), channels: z.array(z.string()), severity: z.string().optional() });

export function registerChannelTools(tool: Register, deps: McpDeps): void {
  const setupUrl = () => dashboardLink(deps, "/config?section=channels");

  tool("channels", "polpo_channels_list", {
    title: "List channels",
    description: "Where the instance reaches people: notification channels (Telegram, Slack, email, webhooks…; name and type only, never their tokens), "
      + "notification rules, the Telegram bots and the groups, topics and people they can write to, WhatsApp profiles and whether they are signed in, "
      + "Slack apps and their Socket Mode connection. "
      + "Use a chat's id or name as `to` in polpo_message_send.",
    inputSchema: {},
    outputSchema: {
      channels: z.array(channelItem), rules: z.array(ruleItem),
      telegram: z.object({ bots: z.array(z.object({ key: z.string(), agent: z.string().optional() })), chats: z.array(z.object({ id: z.string(), kind: z.string(), name: z.string() })) }),
      whatsapp: z.array(z.object({ profile: z.string(), status: z.string() })),
      slack: z.array(z.object({ channel: z.string(), state: z.string(), inbound: z.boolean() })),
      setup_url: z.string(),
    },
    annotations: READ,
  }, async () => {
    const [cfg, tg, wa] = await Promise.all([apiGet(deps, "/config"), apiGet(deps, "/telegram/chats"), apiGet(deps, "/whatsapp/profiles")]);
    if (!cfg.ok) return apiError(cfg, "Reading the channels");
    const n = (cfg.data as { settings?: { notifications?: { channels?: Record<string, { type?: string }>; rules?: Rule[] } } })?.settings?.notifications;
    // the Slack apps' connection, only when there is one (each call counts against the API's rate limit)
    const sl = Object.values(n?.channels ?? {}).some((c) => c?.type === "slack") ? await apiGet(deps, "/slack") : undefined;
    const channels = Object.entries(n?.channels ?? {}).map(([name, c]) => ({ name, type: c?.type ?? "unknown" }));
    const rules = (n?.rules ?? []).map((r) => ({ id: r.id, ...(r.name ? { name: r.name } : {}), events: r.events ?? [], channels: r.channels ?? [], ...(r.severity ? { severity: r.severity } : {}) }));
    const tgd = (tg.ok ? tg.data : {}) as { bots?: Array<{ key: string; agent?: string }>; chats?: Array<{ id: string; kind: string; name: string }> };
    const telegram = {
      bots: (tgd.bots ?? []).map((b) => ({ key: b.key, ...(b.agent ? { agent: b.agent } : {}) })),
      chats: (tgd.chats ?? []).map((c) => ({ id: c.id, kind: c.kind, name: c.name })),
    };
    const whatsapp = ((wa.ok ? (wa.data as { profiles?: Array<{ profileDir: string; status: string }> })?.profiles : []) ?? []).map((p) => ({ profile: p.profileDir, status: p.status }));
    const slack = ((sl?.ok ? (sl.data as { channels?: Array<{ channel: string; state: string; inbound: boolean }> })?.channels : []) ?? []).map((s) => ({ channel: s.channel, state: s.state, inbound: s.inbound }));
    const text = [
      `notification channels: ${channels.map((c) => `${c.name} (${c.type})`).join(", ") || "none"}`,
      `rules: ${rules.map((r) => `${r.name ?? r.id} [${r.events.join(", ")} → ${r.channels.join(", ")}]`).join("; ") || "none"}`,
      `Telegram bots: ${telegram.bots.map((b) => `${b.key}${b.agent ? ` (as ${b.agent})` : " (as Polpo)"}`).join(", ") || "none"}`,
      ...(telegram.chats.length ? ["Telegram chats:", ...telegram.chats.slice(0, 50).map((c) => `- ${c.id} (${c.kind}) ${c.name}`)] : []),
      `WhatsApp: ${whatsapp.map((w) => `${w.profile} (${w.status})`).join(", ") || "not set up"}`,
      ...(slack.length ? [`Slack: ${slack.map((s) => `${s.channel} (${s.inbound ? s.state : "notifications only"})`).join(", ")}`] : []),
      `To set up a channel: polpo_channel_save (its tokens and keys: ${setupUrl()})`,
    ].join("\n");
    return ok(text, { channels, rules, telegram, whatsapp, slack, setup_url: setupUrl() });
  });

  tool("channels", "polpo_channel_test", {
    title: "Test a notification channel",
    description: "Send a test notification on a channel (polpo_channels_list) and say whether it arrived.",
    inputSchema: { name: z.string().min(1).describe("The channel's name") },
    outputSchema: { name: z.string(), success: z.boolean(), error: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: "polpo:messages",
  }, async ({ name }) => {
    const r = await apiSend(deps, "POST", `/config/channels/${enc(name)}/test`);
    if (!r.ok) return r.status === 404 ? fail(`There is no channel "${name}" running. List them with polpo_channels_list; set one up with polpo_channel_save (its secrets: ${setupUrl()}).`) : apiError(r, `Testing channel ${name}`);
    const d = r.data as { success?: boolean; error?: string };
    // the link opens this channel's sheet (?channel=)
    const channelUrl = dashboardLink(deps, `/config?section=channels&channel=${enc(name)}`);
    return ok(d.success ? `The test on ${name} was sent.` : `The test on ${name} failed: ${d.error ?? "unknown error"}. Check the channel in the dashboard (${channelUrl}).`,
      { name, success: !!d.success, ...(d.error ? { error: d.error } : {}) });
  });

  tool("channels", "polpo_message_send", {
    title: "Send a message",
    description: "Send a message now, as Polpo or an agent, on any channel: Telegram (to a group, topic or person by name or id from polpo_channels_list; "
      + "with files from the workspace), WhatsApp (to a phone number or chat; text, or one file with a caption), email (with the agent's mail account; "
      + "attachments from the workspace), Slack (to a channel id like C0123 or a DM, optionally in a thread: thread_ts; default the channel's own), "
      + "WhatsApp Business (to a contact: free-form only inside the 24-hour window and never to someone who opted out — templates go with "
      + "polpo_wabiz_send_template; without `to`, a notification to the operators), a webhook (POSTs to its URL), browser push or the mobile app "
      + "(expo-push: every registered device). `name` picks the configured channel when there are several of that type. "
      + "It is real and cannot be undone: show the person the message, then call with confirm: true.",
    inputSchema: {
      channel: z.enum(SEND_CHANNELS).describe("How to send it"),
      name: z.string().min(1).optional().describe("Slack, webhook, push, expo-push, WhatsApp Business: the configured channel's name (default: the only one of that type)"),
      to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional()
        .describe("Telegram: a chat's name or id; WhatsApp: a phone number (+39…) or chat; email: one address or a list; Slack: a channel id (default: the channel's); WhatsApp Business: the contact (+39…)"),
      text: z.string().max(20_000).optional().describe("The message (email: the body)"),
      title: z.string().max(200).optional().describe("Slack, webhook, push, expo-push: the notification's title"),
      subject: z.string().max(500).optional().describe("Email: the subject"),
      html: z.boolean().optional().describe("Email: the body is HTML"),
      cc: z.array(z.string()).optional().describe("Email: cc"),
      files: z.array(z.string().min(1)).max(10).optional().describe("Telegram, WhatsApp, email: paths in the workspace to send (WhatsApp: one file, text is its caption)"),
      agent: z.string().optional().describe("The agent it is sent as (its Telegram bot, its mail account); omit for Polpo"),
      topic: z.number().int().optional().describe("Telegram: a forum topic inside the group"),
      thread_ts: z.string().regex(/^\d{1,10}\.\d{6}$/, "a Slack message ts like 1712345678.123456").optional().describe("Slack: reply in this thread (the parent message's ts)"),
      confirm: confirmParam("send it (after the person saw it and agreed)"),
    },
    outputSchema: { sent: z.boolean(), channel: z.string(), name: z.string().optional(), message_id: z.string().optional(), to: z.unknown().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    scope: "polpo:messages",
  }, async ({ channel, name, to, text, title, subject, html, cc, files, agent, topic, thread_ts, confirm }) => {
    const missing = await unknownAgents(deps, [agent]);
    if (missing) return fail(missing);
    const recipients = to === undefined ? [] : Array.isArray(to) ? to : [to];
    const viaRouter = ROUTER_CHANNELS.includes(channel as (typeof ROUTER_CHANNELS)[number]);
    if (!viaRouter && recipients.length === 0) return fail(`${channel} needs \`to\`.`);
    if (channel !== "email" && recipients.length > 1) return fail(`${channel} sends to one chat at a time: call once per recipient.`);
    if (channel === "email" && (!subject?.trim() || !text?.trim())) return fail("An email needs subject and text (the body).");
    if (channel === "whatsapp" && (files?.length ?? 0) > 1) return fail("WhatsApp sends one file at a time: call once per file.");
    if (viaRouter && files?.length) return fail(`${channel} sends text only here: send files on Telegram, WhatsApp or email.`);
    if ((channel === "webhook" || channel === "push" || channel === "expo-push") && recipients.length) return fail(`${channel} has no recipient: it goes to the channel's URL or every subscribed device. Leave \`to\` out.`);
    if (thread_ts && channel !== "slack") return fail("thread_ts is for Slack.");
    if (!text?.trim() && !files?.length) return fail("Nothing to send: give text or files.");

    // the configured channel, for the channels sent through the notification router
    let channelName: string | undefined;
    if (viaRouter) {
      const cfg = await apiGet(deps, "/config");
      if (!cfg.ok) return apiError(cfg, "Reading the channels");
      const all = Object.entries((cfg.data as { settings?: { notifications?: { channels?: Record<string, { type?: string }> } } })?.settings?.notifications?.channels ?? {});
      const ofType = all.filter(([, c]) => c?.type === channel).map(([n]) => n);
      if (name) {
        const c = all.find(([n]) => n === name)?.[1];
        if (!c) return fail(`There is no channel "${name}". ${ofType.length ? `${channel} channels: ${ofType.join(", ")}.` : `Set one up with polpo_channel_save (type ${channel}).`}`);
        if (c.type !== channel) return fail(`${name} is a ${String(c.type)} channel, not ${channel}.`);
        channelName = name;
      } else if (ofType.length === 1) channelName = ofType[0];
      else return fail(ofType.length ? `Say which ${channel} channel (name): ${ofType.join(", ")}.` : `There is no ${channel} channel: set one up with polpo_channel_save (its secrets: ${setupUrl()}).`);
    }

    if (confirm !== true) {
      const where = channelName ? `${channel} (${channelName})` : channel;
      const preview = channel === "email"
        ? `Email to ${recipients.join(", ")}: "${subject}"\n${short(text, 600)}`
        : `${where}${recipients[0] ? ` to ${recipients[0]}` : ""}${topic !== undefined ? ` (topic ${topic})` : ""}${thread_ts ? ` (thread ${thread_ts})` : ""}: ${title ? `${title} — ` : ""}${short(text ?? "", 600)}`;
      return fail(`Ready to send, not sent:\n${preview}${files?.length ? `\nfiles: ${files.join(", ")}` : ""}\nShow it to the person; if they agree, call again with confirm: true.`);
    }
    let r;
    if (channel === "telegram") {
      r = await apiSend(deps, "POST", "/telegram/send", { to: recipients[0], ...(text ? { text } : {}), ...(files?.length ? { files } : {}), ...(agent ? { agent } : {}), ...(topic !== undefined ? { topic } : {}) });
    } else if (channel === "whatsapp") {
      r = files?.length
        ? await apiSend(deps, "POST", "/whatsapp/send-file", { to: recipients[0], path: files[0], ...(text ? { caption: text } : {}) })
        : await apiSend(deps, "POST", "/whatsapp/send", { to: recipients[0], message: text });
    } else if (channel === "email") {
      r = await apiSend(deps, "POST", "/email/send", {
        to: recipients.length === 1 ? recipients[0] : recipients, subject, body: text, ...(html ? { html } : {}), ...(cc?.length ? { cc } : {}),
        ...(files?.length ? { attachments: files.map((path) => ({ path })) } : {}), ...(agent ? { agent } : {}),
      });
    } else if (channel === "whatsapp-business" && recipients[0]) {
      // a contact: the service checks the 24-hour window and the opt-out
      r = await apiSend(deps, "POST", `/whatsapp-business/${enc(channelName!)}/send`, { to: recipients[0], text, by: agent ?? "polpo" });
    } else {
      // the notification router: the channel applies its own rules (Slack's target, the business number's window and caps)
      r = await apiSend(deps, "POST", "/notifications/send", {
        channel: channelName, title: title ?? (agent ? `Message from ${agent}` : "Message"), body: text, throwOnError: true,
        ...(recipients[0] ? { to: recipients[0] } : {}), ...(thread_ts ? { threadTs: thread_ts } : {}),
      });
    }
    if (!r.ok) {
      if (r.status === 503) return fail(`${channel} is not set up on this instance: the person sets it up in the dashboard (${setupUrl()}).`);
      return apiError(r, `Sending on ${channelName ?? channel}`, "Nothing was sent. Check the recipient (polpo_channels_list), the channel's setup (polpo_channel_test) and the files' paths.");
    }
    const d = r.data as { id?: string; to?: unknown; bot?: string; ids?: string[] };
    const id = d.id ?? d.ids?.[0];
    return ok(`Sent on ${channelName ? `${channel} (${channelName})` : channel}${recipients.length ? ` to ${recipients.join(", ")}` : ""}${id ? ` (id ${id})` : ""}.`,
      { sent: true, channel, ...(channelName ? { name: channelName } : {}), ...(id ? { message_id: String(id) } : {}), ...(d.to ? { to: d.to } : recipients[0] ? { to: recipients[0] } : {}) });
  });

  // ── Notification history ──

  tool("channels", "polpo_notifications_list", {
    title: "List sent notifications",
    description: "The notification history, newest first: what each rule (or a direct send) sent, on which channel, when, and whether it was sent or "
      + "failed (with the error). Filter by status, channel or rule.",
    inputSchema: {
      status: z.enum(["sent", "failed"]).optional().describe("Only sent or only failed ones"),
      channel: z.string().min(1).optional().describe("Only this channel"),
      rule: z.string().min(1).optional().describe("Only this rule's id (direct sends: direct)"),
      limit: z.number().int().min(1).max(500).optional().describe("How many (default 50)"),
    },
    outputSchema: { notifications: z.array(looseObject) },
    annotations: READ,
  }, async ({ status, channel, rule, limit }) => {
    const filters = [status, channel, rule].filter(Boolean).length;
    if (filters > 1) return fail("Filter by one of status, channel or rule at a time.");
    const r = await apiGet(deps, `/notifications${qs({ limit: String(limit ?? 50), status, channel, rule })}`);
    if (!r.ok) return apiError(r, "Reading the notification history");
    const list = (Array.isArray(r.data) ? r.data : []) as Array<{ id: string; timestamp: string; ruleName?: string; ruleId?: string; channel: string; status: string; title?: string; error?: string }>;
    return ok(list.map((n) => `- ${n.timestamp} ${n.status} ${n.channel} [${n.ruleName ?? n.ruleId ?? "?"}] ${short(n.title ?? "", 120)}${n.error ? ` — ${short(n.error, 200)}` : ""}`).join("\n") || "No notifications yet.",
      { notifications: list as unknown as Array<Record<string, unknown>> });
  });

  tool("channels", "polpo_notifications_stats", {
    title: "Notification counts",
    description: "How many notifications were sent and how many failed, in total.",
    inputSchema: {},
    outputSchema: { total: z.number(), sent: z.number(), failed: z.number() },
    annotations: READ,
  }, async () => {
    const r = await apiGet(deps, "/notifications/stats");
    if (!r.ok) return apiError(r, "Reading the notification counts");
    const d = r.data as { total?: number; sent?: number; failed?: number };
    const out = { total: d.total ?? 0, sent: d.sent ?? 0, failed: d.failed ?? 0 };
    return ok(`${out.total} notifications: ${out.sent} sent, ${out.failed} failed.`, out);
  });

  tool("channels", "polpo_notification_rule_save", {
    title: "Save a notification rule",
    description: "Create or replace a notification rule: when events happen (e.g. task:failed, mission:completed, approval:requested), "
      + "notify on channels (polpo_channels_list). Same id replaces the rule.",
    inputSchema: {
      id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/, "letters, digits, '.', '_' and '-'").describe("The rule's id (an existing one to replace it)"),
      name: z.string().min(1).max(120).optional().describe("A readable name"),
      events: z.array(z.string().min(1)).min(1).describe("Events, e.g. ['task:failed', 'mission:completed'] (wildcards like 'task:*' allowed)"),
      channels: z.array(z.string().min(1)).min(1).describe("Channel names to notify"),
      severity: z.enum(["info", "warning", "critical"]).optional().describe("How important"),
      template: z.string().max(4000).optional().describe("The message, with {{placeholders}} of the event"),
      cooldown_minutes: z.number().min(0).max(24 * 60).optional().describe("At most one notification per this many minutes"),
      condition: z.object({ expression: z.string().min(1).max(2000) }).passthrough().optional().describe("Only when this expression on the event holds"),
      include_outcomes: z.boolean().optional().describe("Attach the task's outcomes (files, reports)"),
      outcome_filter: z.object({ types: z.array(z.string()).optional(), tags: z.array(z.string()).optional() }).strict().optional().describe("Which outcomes to attach"),
      max_attachment_size: z.number().int().min(0).optional().describe("Largest attachment in bytes"),
      actions: z.array(z.object({}).passthrough()).optional().describe("Actions to run as well (as in the dashboard's rule editor)"),
    },
    outputSchema: { rule: ruleItem, created: z.boolean() },
    annotations: UPDATE,
  }, async ({ id, name, events, channels, severity, template, cooldown_minutes, condition, include_outcomes, outcome_filter, max_attachment_size, actions }) => {
    const cfg = await apiGet(deps, "/config");
    if (!cfg.ok) return apiError(cfg, "Reading the configuration");
    const n = (cfg.data as { settings?: { notifications?: { channels?: Record<string, unknown>; rules?: Rule[] } } })?.settings?.notifications;
    const known = Object.keys(n?.channels ?? {});
    const unknown = channels.filter((c) => !known.includes(c));
    if (unknown.length) return fail(`No channel ${unknown.map((c) => `"${c}"`).join(", ")}. Channels: ${known.join(", ") || "none"} (set one up with polpo_channel_save).`);
    const existed = (n?.rules ?? []).some((r) => r.id === id);
    const rule = {
      id, ...(name ? { name } : {}), events, channels, ...(severity ? { severity } : {}), ...(template ? { template } : {}),
      ...(cooldown_minutes !== undefined ? { cooldownMs: Math.round(cooldown_minutes * 60_000) } : {}),
      ...(condition ? { condition } : {}), ...(include_outcomes !== undefined ? { includeOutcomes: include_outcomes } : {}),
      ...(outcome_filter ? { outcomeFilter: outcome_filter } : {}), ...(max_attachment_size !== undefined ? { maxAttachmentSize: max_attachment_size } : {}),
      ...(actions ? { actions } : {}),
    };
    const r = await apiSend(deps, "PUT", `/config/rules/${enc(id)}`, rule);
    if (!r.ok) return apiError(r, `Saving rule ${id}`);
    return ok(`${existed ? "Replaced" : "Created"} rule ${id}: ${events.join(", ")} → ${channels.join(", ")}.`, { rule: { id, ...(name ? { name } : {}), events, channels, ...(severity ? { severity } : {}) }, created: !existed });
  });

  tool("channels", "polpo_notification_rule_delete", {
    title: "Delete a notification rule",
    description: "Delete a notification rule (polpo_channels_list lists them). Needs confirm: true.",
    inputSchema: { id: z.string().min(1).describe("The rule's id"), confirm: confirmParam("delete the rule") },
    outputSchema: { id: z.string(), deleted: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ id, confirm }) => {
    if (confirm !== true) return fail(`Deleting rule ${id} stops its notifications: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/config/rules/${enc(id)}`);
    if (!r.ok) return r.status === 404 ? fail(`There is no rule "${id}". List them with polpo_channels_list.`) : apiError(r, `Deleting rule ${id}`);
    return ok(`Deleted rule ${id}.`, { id, deleted: true });
  });
}

type VaultEntry = { service: string; type: string; label?: string; account?: string; keys?: string[]; sharedFrom?: string; readOnly?: boolean; allowedAgents?: string[] };

export function registerVaultTools(tool: Register, deps: McpDeps): void {
  const entryItem = z.object({
    agent: z.string(), service: z.string(), type: z.string(), label: z.string().optional(), account: z.string().optional(),
    fields: z.array(z.string()).describe("The names of its fields, never their values"), shared_from: z.string().optional(),
  });
  /** Only names and metadata: whatever the API returns, values are never copied. */
  const view = (agent: string, e: VaultEntry) => ({
    agent, service: e.service, type: e.type, ...(e.label ? { label: e.label } : {}), ...(e.account ? { account: e.account } : {}),
    fields: Array.isArray(e.keys) ? e.keys.filter((k) => typeof k === "string") : [], ...(e.sharedFrom ? { shared_from: e.sharedFrom } : {}),
  });

  tool("vault", "polpo_vault_list", {
    title: "List vault entries",
    description: "The credentials agents have in the vault (mail accounts, API keys, logins…): service, type, label and the names of the fields, "
      + "never their values. Secrets are added or changed only in the dashboard (setup_url), never through this connector.",
    inputSchema: {
      agent: z.string().optional().describe("One agent's entries (default: every agent's)"),
      limit: limitParam(50, 200),
      cursor: cursorParam(),
    },
    outputSchema: { ...pageOutput(entryItem), setup_url: z.string() },
    annotations: READ,
  }, async ({ agent, limit, cursor }) => {
    let agents: string[];
    if (agent) agents = [agent];
    else {
      const a = await apiGet(deps, "/agents");
      if (!a.ok) return apiError(a, "Listing agents");
      agents = ((a.data as Array<{ name: string }>) ?? []).map((x) => x.name);
    }
    const all: Array<ReturnType<typeof view>> = [];
    for (const name of agents) {
      const r = await apiGet(deps, `/vault/entries/${enc(name)}`);
      if (!r.ok) {
        if (agent) return r.status === 503 ? fail("The vault is not available on this instance.") : apiError(r, `Listing ${name}'s vault`);
        continue;
      }
      for (const e of (r.data as VaultEntry[]) ?? []) all.push(view(name, e));
    }
    const p = page(all, limit ?? 50, cursor);
    if (!p) return fail(BAD_CURSOR);
    const setup = dashboardLink(deps, agent ? `/agents/${enc(agent)}?tab=credentials` : "/agents");
    return ok(`${p.items.map((e) => `- ${e.agent}/${e.service} (${e.type}${e.label ? `, ${e.label}` : ""}): ${e.fields.join(", ") || "no fields"}${e.shared_from ? ` (shared from ${e.shared_from})` : ""}`).join("\n") || "No vault entries."}`
      + `${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}\nTo add or change a secret: ${setup}`, { ...p, setup_url: setup });
  });

  tool("vault", "polpo_vault_delete", {
    title: "Delete a vault entry",
    description: "Delete one of an agent's vault entries (its credentials for a service): the agent can no longer use that account. It cannot be undone. Needs confirm: true.",
    inputSchema: {
      agent: z.string().min(1).describe("The agent's name"),
      service: z.string().min(1).describe("The entry's service (polpo_vault_list)"),
      confirm: confirmParam("delete the entry"),
    },
    outputSchema: { agent: z.string(), service: z.string(), removed: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ agent, service, confirm }) => {
    const list = await apiGet(deps, `/vault/entries/${enc(agent)}`);
    if (!list.ok) return list.status === 503 ? fail("The vault is not available on this instance.") : apiError(list, `Listing ${agent}'s vault`);
    const entry = ((list.data as VaultEntry[]) ?? []).find((e) => e.service === service);
    if (!entry) return fail(`${agent} has no vault entry "${service}". List them with polpo_vault_list.`);
    if (entry.readOnly || entry.sharedFrom) return fail(`${service} is shared with ${agent} by ${entry.sharedFrom ?? "another agent"}: delete it there.`);
    if (confirm !== true) return fail(`Deleting ${agent}'s ${service} credentials cannot be undone: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/vault/entries/${enc(agent)}/${enc(service)}`);
    if (!r.ok) return apiError(r, `Deleting ${agent}/${service}`);
    const removed = !!(r.data as { removed?: boolean })?.removed;
    return ok(removed ? `Deleted ${agent}'s ${service} credentials.` : `Nothing was deleted (${agent}/${service} was not found).`, { agent, service, removed });
  });
}
