/**
 * Channels: where the instance talks to people (notification channels, Telegram bots and the chats
 * they reach, WhatsApp, email), sending a message or a file now, and the notification rules. The
 * vault: which credentials each agent has (names and metadata, never values).
 *
 * Secrets never pass through here: bot tokens, SMTP passwords and API keys are entered in the
 * dashboard (setup_url). Changing the notification rules needs polpo:admin; sending a message (or a
 * test) polpo:messages, and confirm: true; the vault, reads too, polpo:vault.
 */
import { z } from "zod";
import {
  BAD_CURSOR, DESTRUCTIVE, READ, UPDATE, apiError, apiGet, apiSend, confirmParam, cursorParam, dashboardLink, enc, fail, limitParam, ok,
  page, pageOutput, short,
  type McpDeps, type Register,
} from "./kit.js";
import { unknownAgents } from "./tasks.js";

type Rule = { id: string; name?: string; events: string[]; channels: string[]; severity?: string; template?: string; cooldownMs?: number };

const channelItem = z.object({ name: z.string(), type: z.string() });
const ruleItem = z.object({ id: z.string(), name: z.string().optional(), events: z.array(z.string()), channels: z.array(z.string()), severity: z.string().optional() });

export function registerChannelTools(tool: Register, deps: McpDeps): void {
  const setupUrl = dashboardLink(deps, "/config?section=channels");

  tool("channels", "polpo_channels_list", {
    title: "List channels",
    description: "Where the instance reaches people: notification channels (Telegram, Slack, email, webhooks…; name and type only, never their tokens), "
      + "notification rules, the Telegram bots and the groups, topics and people they can write to, WhatsApp profiles and whether they are signed in. "
      + "Use a chat's id or name as `to` in polpo_message_send.",
    inputSchema: {},
    outputSchema: {
      channels: z.array(channelItem), rules: z.array(ruleItem),
      telegram: z.object({ bots: z.array(z.object({ key: z.string(), agent: z.string().optional() })), chats: z.array(z.object({ id: z.string(), kind: z.string(), name: z.string() })) }),
      whatsapp: z.array(z.object({ profile: z.string(), status: z.string() })),
      setup_url: z.string(),
    },
    annotations: READ,
  }, async () => {
    const [cfg, tg, wa] = await Promise.all([apiGet(deps, "/config"), apiGet(deps, "/telegram/chats"), apiGet(deps, "/whatsapp/profiles")]);
    if (!cfg.ok) return apiError(cfg, "Reading the channels");
    const n = (cfg.data as { settings?: { notifications?: { channels?: Record<string, { type?: string }>; rules?: Rule[] } } })?.settings?.notifications;
    const channels = Object.entries(n?.channels ?? {}).map(([name, c]) => ({ name, type: c?.type ?? "unknown" }));
    const rules = (n?.rules ?? []).map((r) => ({ id: r.id, ...(r.name ? { name: r.name } : {}), events: r.events ?? [], channels: r.channels ?? [], ...(r.severity ? { severity: r.severity } : {}) }));
    const tgd = (tg.ok ? tg.data : {}) as { bots?: Array<{ key: string; agent?: string }>; chats?: Array<{ id: string; kind: string; name: string }> };
    const telegram = {
      bots: (tgd.bots ?? []).map((b) => ({ key: b.key, ...(b.agent ? { agent: b.agent } : {}) })),
      chats: (tgd.chats ?? []).map((c) => ({ id: c.id, kind: c.kind, name: c.name })),
    };
    const whatsapp = ((wa.ok ? (wa.data as { profiles?: Array<{ profileDir: string; status: string }> })?.profiles : []) ?? []).map((p) => ({ profile: p.profileDir, status: p.status }));
    const text = [
      `notification channels: ${channels.map((c) => `${c.name} (${c.type})`).join(", ") || "none"}`,
      `rules: ${rules.map((r) => `${r.name ?? r.id} [${r.events.join(", ")} → ${r.channels.join(", ")}]`).join("; ") || "none"}`,
      `Telegram bots: ${telegram.bots.map((b) => `${b.key}${b.agent ? ` (as ${b.agent})` : " (as Polpo)"}`).join(", ") || "none"}`,
      ...(telegram.chats.length ? ["Telegram chats:", ...telegram.chats.slice(0, 50).map((c) => `- ${c.id} (${c.kind}) ${c.name}`)] : []),
      `WhatsApp: ${whatsapp.map((w) => `${w.profile} (${w.status})`).join(", ") || "not set up"}`,
      `To set up a channel: polpo_channel_save (its tokens and keys: ${setupUrl})`,
    ].join("\n");
    return ok(text, { channels, rules, telegram, whatsapp, setup_url: setupUrl });
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
    if (!r.ok) return r.status === 404 ? fail(`There is no channel "${name}" running. List them with polpo_channels_list; set one up with polpo_channel_save (its secrets: ${setupUrl}).`) : apiError(r, `Testing channel ${name}`);
    const d = r.data as { success?: boolean; error?: string };
    return ok(d.success ? `The test on ${name} was sent.` : `The test on ${name} failed: ${d.error ?? "unknown error"}. Check the channel in the dashboard (${setupUrl}).`,
      { name, success: !!d.success, ...(d.error ? { error: d.error } : {}) });
  });

  tool("channels", "polpo_message_send", {
    title: "Send a message",
    description: "Send a message now, as Polpo or an agent: on Telegram (to a group, topic or person by name or id from polpo_channels_list; with files from the workspace), "
      + "on WhatsApp (to a phone number or chat; text, or one file with a caption), or by email (with the agent's mail account; attachments from the workspace). "
      + "It is real and cannot be undone: show the person the message, then call with confirm: true.",
    inputSchema: {
      channel: z.enum(["telegram", "whatsapp", "email"]).describe("How to send it"),
      to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).describe("Telegram: a chat's name or id; WhatsApp: a phone number (+39…) or chat; email: one address or a list"),
      text: z.string().max(20_000).optional().describe("The message (email: the body)"),
      subject: z.string().max(500).optional().describe("Email: the subject"),
      html: z.boolean().optional().describe("Email: the body is HTML"),
      cc: z.array(z.string()).optional().describe("Email: cc"),
      files: z.array(z.string().min(1)).max(10).optional().describe("Paths in the workspace to send (WhatsApp: one file, text is its caption)"),
      agent: z.string().optional().describe("The agent it is sent as (its Telegram bot, its mail account); omit for Polpo"),
      topic: z.number().int().optional().describe("Telegram: a forum topic inside the group"),
      confirm: confirmParam("send it (after the person saw it and agreed)"),
    },
    outputSchema: { sent: z.boolean(), channel: z.string(), message_id: z.string().optional(), to: z.unknown().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    scope: "polpo:messages",
  }, async ({ channel, to, text, subject, html, cc, files, agent, topic, confirm }) => {
    const missing = await unknownAgents(deps, [agent]);
    if (missing) return fail(missing);
    const recipients = Array.isArray(to) ? to : [to];
    if (channel !== "email" && recipients.length > 1) return fail(`${channel} sends to one chat at a time: call once per recipient.`);
    if (channel === "email" && (!subject?.trim() || !text?.trim())) return fail("An email needs subject and text (the body).");
    if (channel === "whatsapp" && (files?.length ?? 0) > 1) return fail("WhatsApp sends one file at a time: call once per file.");
    if (!text?.trim() && !files?.length) return fail("Nothing to send: give text or files.");
    if (confirm !== true) {
      const preview = channel === "email" ? `Email to ${recipients.join(", ")}: "${subject}"\n${short(text, 600)}` : `${channel} to ${recipients[0]}${topic !== undefined ? ` (topic ${topic})` : ""}: ${short(text ?? "", 600)}`;
      return fail(`Ready to send, not sent:\n${preview}${files?.length ? `\nfiles: ${files.join(", ")}` : ""}\nShow it to the person; if they agree, call again with confirm: true.`);
    }
    let r;
    if (channel === "telegram") {
      r = await apiSend(deps, "POST", "/telegram/send", { to: recipients[0], ...(text ? { text } : {}), ...(files?.length ? { files } : {}), ...(agent ? { agent } : {}), ...(topic !== undefined ? { topic } : {}) });
    } else if (channel === "whatsapp") {
      r = files?.length
        ? await apiSend(deps, "POST", "/whatsapp/send-file", { to: recipients[0], path: files[0], ...(text ? { caption: text } : {}) })
        : await apiSend(deps, "POST", "/whatsapp/send", { to: recipients[0], message: text });
    } else {
      r = await apiSend(deps, "POST", "/email/send", {
        to: recipients.length === 1 ? recipients[0] : recipients, subject, body: text, ...(html ? { html } : {}), ...(cc?.length ? { cc } : {}),
        ...(files?.length ? { attachments: files.map((path) => ({ path })) } : {}), ...(agent ? { agent } : {}),
      });
    }
    if (!r.ok) {
      if (r.status === 503) return fail(`${channel} is not set up on this instance: the person sets it up in the dashboard (${setupUrl}).`);
      return apiError(r, `Sending on ${channel}`, "Nothing was sent. Check the recipient (polpo_channels_list) and the files' paths.");
    }
    const d = r.data as { id?: string; to?: unknown; bot?: string };
    return ok(`Sent on ${channel} to ${recipients.join(", ")}${d.id ? ` (id ${d.id})` : ""}.`,
      { sent: true, channel, ...(d.id ? { message_id: String(d.id) } : {}), ...(d.to ? { to: d.to } : {}) });
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
