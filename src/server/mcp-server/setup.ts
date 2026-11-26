/**
 * Secrets never pass through MCP: the person enters them in the dashboard. This is the hand-off,
 * built so the assistant drives the whole flow and the person only pastes the value:
 *
 *   1. a tool that needs a secret returns `setup_url` (absolute when the dashboard's URL is known:
 *      it opens the exact form, the item selected and the field focused), `setup_id` (what is
 *      awaited, e.g. channel:telegram-ops:botToken) and `next_step` (one line to show the person);
 *   2. the assistant shows the link and calls polpo_setup_wait { setup_id }: it returns as soon as
 *      the secret is there (only whether it exists, never its value);
 *   3. it verifies with the area's test tool (polpo_channel_test, polpo_sandbox_provider_test…) and
 *      goes on.
 */
import { z } from "zod";
import {
  MAX_WAIT_SECONDS, READ, apiGet, dashboardLink, enc, fail, ok, progress, sleep,
  type McpDeps, type Register,
} from "./kit.js";

export const SETUP_KINDS = ["channel", "provider", "custom-provider", "sandbox", "sync", "vault", "connector", "data", "computer-webhook", "wabiz", "mcp-server", "trigger", "slack"] as const;
export type SetupKind = (typeof SETUP_KINDS)[number];

/** What is awaited: a channel's field, a provider's key, a vault entry… */
export interface SetupTarget {
  kind: SetupKind;
  /** The channel, provider, vault owner, connector… */
  item?: string;
  /** The field (botToken, apiKey, secretAccessKey…; for a vault entry, its service). */
  field?: string;
}

/** kind:item:field, e.g. channel:telegram-ops:botToken, provider:openai, sync:r2:secretAccessKey. */
export function setupId(t: SetupTarget): string {
  return [t.kind, t.item ?? "", t.field ?? ""].join(":").replace(/:+$/, "");
}

export function parseSetupId(id: string): SetupTarget | null {
  const [kind, item, ...rest] = id.split(":");
  if (!(SETUP_KINDS as readonly string[]).includes(kind)) return null;
  const field = rest.join(":");
  return { kind: kind as SetupKind, ...(item ? { item } : {}), ...(field ? { field } : {}) };
}

/** The dashboard path that opens the form: section, the item selected, the field focused, and the setup it answers. */
export function setupPath(t: SetupTarget): string {
  const q = (params: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
    p.set("setup", setupId(t));
    return p.toString();
  };
  switch (t.kind) {
    case "channel": return `/config?${q({ section: "channels", channel: t.item, focus: t.field })}`;
    case "provider":
    case "custom-provider": return `/config?${q({ section: "providers", provider: t.item, focus: t.field ?? "apiKey" })}`;
    case "sandbox": return `/config?${q({ section: "sandbox", provider: t.item, focus: t.field ?? "credential" })}`;
    case "sync": return `/config?${q({ section: "sync", focus: t.field ?? "secretAccessKey" })}`;
    case "vault": return `/agents/${enc(t.item ?? "")}?${q({ tab: "credentials", service: t.field })}`;
    case "connector": return `/connectors?${q({ connector: t.item, focus: t.field })}`;
    case "data": return `/data?${q({ tab: "sources", source: t.item, focus: t.field ?? "password" })}`;
    case "computer-webhook": return `/config?${q({ section: "computers", provider: t.item, focus: t.field ?? "secret" })}`;
    case "wabiz": return `/config?${q({ section: "channels", channel: t.item, focus: t.field ?? "accessToken" })}`;
    // a Slack app's token (vault $channels): the channel's sheet, the token's input focused
    case "slack": return `/config?${q({ section: "channels", channel: t.item, focus: t.field ?? "botToken" })}`;
    // a hosted server's secret: its sheet, Settings tab, the secret's input focused
    case "mcp-server": return `/connectors?${q({ tab: "servers", server: t.item, focus: t.field ? `secret:${t.field}` : undefined })}`;
    // a trigger's HMAC signing secret: the trigger's sheet, the Auth section
    case "trigger": return `/triggers?${q({ trigger: t.item, focus: t.field ?? "hmac" })}`;
  }
}

export interface SetupHandoff {
  setup_url: string;
  setup_id: string;
  next_step: string;
}

/** The hand-off for one secret: the link, what to wait for, and the line to show the person. */
export function setupHandoff(deps: McpDeps, t: SetupTarget, what: string): SetupHandoff {
  const url = dashboardLink(deps, setupPath(t));
  const relative = url.startsWith("/");
  return {
    setup_url: url,
    setup_id: setupId(t),
    next_step: `Ask the person to open ${url}${relative ? " (on the dashboard; set POLPO_DASHBOARD_URL for a full link)" : ""}, paste the ${what} and save — `
      + `then call polpo_setup_wait { setup_id: "${setupId(t)}" } and, when it is done, test it.`,
  };
}

/** Several secrets of one item: the first one's link (the form shows them all), every id to wait for. */
export function setupHandoffs(deps: McpDeps, targets: Array<{ target: SetupTarget; what: string }>): (SetupHandoff & { setup_ids: string[] }) | Record<string, never> {
  if (targets.length === 0) return {};
  const first = setupHandoff(deps, targets[0].target, targets.map((t) => t.what).join(" and "));
  const ids = targets.map((t) => setupId(t.target));
  return { ...first, setup_ids: ids, next_step: ids.length > 1 ? first.next_step.replace(`{ setup_id: "${ids[0]}" }`, `{ setup_ids: ${JSON.stringify(ids)} }`) : first.next_step };
}

/** Is the awaited secret there? true/false, or null when it cannot be checked. Only existence, never values. */
export async function setupDone(deps: McpDeps, t: SetupTarget): Promise<boolean | null> {
  switch (t.kind) {
    case "channel": {
      const r = await apiGet(deps, "/config");
      if (!r.ok) return null;
      const ch = (r.data as { settings?: { notifications?: { channels?: Record<string, Record<string, unknown>> } } })?.settings?.notifications?.channels?.[t.item ?? ""];
      if (!ch) return false;
      const fields = (t.field ?? "").split("|").filter(Boolean);
      return fields.length ? fields.some((f) => !!ch[f]) : true;
    }
    case "provider": {
      const r = await apiGet(deps, "/providers");
      if (!r.ok) return null;
      return ((r.data as Array<{ name: string; hasKey: boolean }>) ?? []).some((p) => p.name === t.item && p.hasKey);
    }
    case "custom-provider": {
      const r = await apiGet(deps, `/providers/custom/${enc(t.item ?? "")}`);
      if (!r.ok) return r.status === 404 ? false : null;
      return !!(r.data as { configured?: boolean }).configured;
    }
    case "sandbox": {
      const r = await apiGet(deps, "/sandbox/providers");
      if (!r.ok) return null;
      return ((r.data as Array<{ id: string; keyFound?: boolean }>) ?? []).some((p) => p.id === t.item && !!p.keyFound);
    }
    case "sync": {
      const r = await apiGet(deps, "/sync/config");
      if (!r.ok) return null;
      return !!(r.data as { r2?: { secretAccessKey?: string } }).r2?.secretAccessKey;
    }
    case "vault": {
      const r = await apiGet(deps, "/vault-catalog");
      if (!r.ok) return null;
      return ((r.data as Array<{ owner: string; service: string }>) ?? []).some((e) => e.owner === t.item && e.service === t.field);
    }
    case "connector": {
      const r = await apiGet(deps, `/connectors/${enc(t.item ?? "")}`);
      if (!r.ok) return r.status === 404 ? false : null;
      const s = (r.data as { secrets?: { bearerToken?: boolean; headers?: string[]; clientSecret?: boolean; oauth?: { authorized?: boolean } } }).secrets;
      if (!s) return null;
      if (t.field === "bearerToken") return !!s.bearerToken;
      if (t.field === "clientSecret") return !!s.clientSecret;
      if (t.field === "headers") return (s.headers ?? []).length > 0;
      return !!s.bearerToken || (s.headers ?? []).length > 0 || !!s.clientSecret || !!s.oauth?.authorized;
    }
    case "data": {
      // a data source's credentials (vault $data / data:<id>): their field names only
      const r = await apiGet(deps, `/data/${enc(t.item ?? "")}`);
      if (!r.ok) return r.status === 404 ? false : null;
      const keys = (r.data as { credentialKeys?: string[] }).credentialKeys;
      if (!keys) return null;
      return t.field ? keys.includes(t.field) : keys.length > 0;
    }
    case "computer-webhook": {
      // a computer provider's webhook signing secret (vault $computers): whether it is set
      const r = await apiGet(deps, "/computer-webhooks");
      if (!r.ok) return null;
      return ((r.data as { providers?: Array<{ provider: string; secretSet: boolean }> }).providers ?? []).some((p) => p.provider === t.item && p.secretSet);
    }
    case "wabiz": {
      // a WhatsApp Business channel's secret (vault $channels): whether it is set
      const r = await apiGet(deps, `/whatsapp-business/${enc(t.item ?? "")}/status`);
      if (!r.ok) return r.status === 404 ? false : null;
      const secrets = (r.data as { secrets?: Record<string, boolean> }).secrets ?? {};
      return t.field ? !!secrets[t.field] : Object.values(secrets).every(Boolean);
    }
    case "slack": {
      // a Slack channel's token (vault $channels): whether it is set
      const r = await apiGet(deps, `/slack/${enc(t.item ?? "")}/status`);
      if (!r.ok) return r.status === 404 ? false : null;
      const secrets = (r.data as { secrets?: Record<string, boolean> }).secrets ?? {};
      return t.field ? !!secrets[t.field] : Object.values(secrets).every(Boolean);
    }
    case "mcp-server": {
      // a hosted server's secret (its vault entry): whether it is set
      const r = await apiGet(deps, `/mcp-servers/${enc(t.item ?? "")}`);
      if (!r.ok) return r.status === 404 ? false : null;
      const secrets = (r.data as { secrets?: Record<string, boolean> }).secrets ?? {};
      return t.field ? !!secrets[t.field] : Object.values(secrets).every(Boolean);
    }
    case "trigger": {
      // a trigger's HMAC signing secret (vault $triggers): whether it is set
      const r = await apiGet(deps, `/triggers/${enc(t.item ?? "")}`);
      if (!r.ok) return r.status === 404 ? false : null;
      return !!(r.data as { hmacSecret?: { secretSet?: boolean } }).hmacSecret?.secretSet;
    }
  }
}

export function registerSetupTools(tool: Register, deps: McpDeps): void {
  tool("settings", "polpo_setup_wait", {
    title: "Wait for a secret the person enters",
    description: "After showing the person a setup_url (from any tool that needs a secret), wait until they saved it: returns as soon as "
      + "every setup_id is done (the secret exists; its value is never read or returned), or pending at the timeout — call again to keep "
      + "waiting. Then verify with the area's test tool (polpo_channel_test, polpo_sandbox_provider_test, polpo_sync_test, polpo_connector_test…) and go on.",
    inputSchema: {
      setup_id: z.string().min(1).optional().describe("What is awaited, as a tool returned it (e.g. channel:telegram-ops:botToken)"),
      setup_ids: z.array(z.string().min(1)).max(20).optional().describe("Several at once"),
      timeout_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe(`How long to wait (default 30, at most ${MAX_WAIT_SECONDS}; 0: just check)`),
    },
    outputSchema: {
      status: z.enum(["done", "pending"]),
      items: z.array(z.object({ setup_id: z.string(), done: z.boolean().nullable() })),
      timed_out: z.boolean(),
    },
    annotations: READ,
  }, async ({ setup_id, setup_ids, timeout_seconds }, extra) => {
    const ids = [...new Set([...(setup_id ? [setup_id] : []), ...(setup_ids ?? [])])];
    if (ids.length === 0) return fail("Give setup_id (or setup_ids) as a tool returned it.");
    const targets = ids.map((id) => [id, parseSetupId(id)] as const);
    const bad = targets.filter(([, t]) => !t).map(([id]) => id);
    if (bad.length) return fail(`Not a setup id: ${bad.join(", ")}. Use the setup_id a tool returned (kind:item:field; kinds: ${SETUP_KINDS.join(", ")}).`);
    const until = Date.now() + (timeout_seconds ?? 30) * 1000;
    for (;;) {
      const items = await Promise.all(targets.map(async ([id, t]) => ({ setup_id: id, done: await setupDone(deps, t!) })));
      const pending = items.filter((i) => i.done === false);
      const unknown = items.filter((i) => i.done === null);
      const finished = pending.length === 0;
      if (finished || Date.now() >= until || extra?.signal?.aborted) {
        const status = finished ? "done" : "pending";
        return ok(finished
          ? `Done: ${items.map((i) => i.setup_id).join(", ")} ${items.length > 1 ? "are" : "is"} saved${unknown.length ? ` (${unknown.map((i) => i.setup_id).join(", ")} could not be checked: test ${unknown.length > 1 ? "them" : "it"})` : ""}. Now test it and go on.`
          : `Still waiting for ${pending.map((i) => i.setup_id).join(", ")}: the person has not saved it yet. Call polpo_setup_wait again to keep waiting.`,
        { status, items, timed_out: !finished });
      }
      await progress(extra, items.length - pending.length, items.length, `waiting for ${pending.map((i) => i.setup_id).join(", ")}`);
      await sleep(deps.pollIntervalMs ?? 1000, extra?.signal);
    }
  });
}
