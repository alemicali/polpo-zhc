/**
 * Which account a connector is signed in as, when the sign-in did not say (no OpenID id_token:
 * Linear, GitHub, Slack, Notion, most Google Workspace servers…). Best effort, after a successful
 * connection: when the server lists an obvious identity tool (whoami, get_me, get_current_user,
 * auth_test…) that is read-only and takes no arguments, it is called once and the email or
 * username it returns labels the connector (ConnectorConfig.account).
 *
 * Never a tool with side effects: the name must say "who am I" and nothing else, it must need no
 * argument, and a tool the server marks destructive (or not read-only) is skipped. Failures and
 * answers without an identity are ignored (the account stays unknown).
 */
import type { McpToolInfo } from "./tools.js";

/**
 * Identity tool names, best first, compared after lowercasing and folding "-", ".", " " to "_".
 * A server prefix is allowed ("slack_auth_test", "users-get_current_user").
 */
const IDENTITY_NAMES = [
  "whoami", "who_am_i", "get_me", "me", "get_self", "get_current_user", "current_user", "users_me", "get_authenticated_user",
  "get_my_profile", "my_profile", "get_profile", "auth_test", "get_viewer", "viewer",
];

const fold = (name: string) => name.toLowerCase().replace(/[-.\s]+/g, "_");

/** Short names ("me", "viewer") only as the whole name: "update_me" is not "who am I". */
const prefixedOk = (n: string) => n.includes("_") || n === "whoami";
/** A prefix that does something ("delete_…", "set_…"): never an identity tool. */
const WRITE_VERB = /(^|_)(update|delete|remove|set|create|send|post|put|patch|edit|add|write|revoke|logout|log_out|sign_out|signout|reset|rename|archive)(_|$)/;

/** Whether the tool takes no required argument. */
function needsNoArguments(tool: McpToolInfo): boolean {
  const required = (tool.inputSchema as { required?: unknown } | undefined)?.required;
  return !Array.isArray(required) || required.length === 0;
}

/** Whether the server says it changes something (destructive, or explicitly not read-only). */
function mayChangeSomething(tool: McpToolInfo): boolean {
  const a = tool.annotations as { readOnlyHint?: unknown; destructiveHint?: unknown } | undefined;
  return a?.destructiveHint === true || a?.readOnlyHint === false;
}

/** The connector's identity tool, if it has an obvious one (read-only, no arguments). */
export function pickIdentityTool(tools: McpToolInfo[]): McpToolInfo | undefined {
  let best: { tool: McpToolInfo; rank: number } | undefined;
  for (const tool of tools) {
    if (!needsNoArguments(tool) || mayChangeSomething(tool)) continue;
    const name = fold(tool.name);
    const rank = IDENTITY_NAMES.findIndex((n) => name === n || (prefixedOk(n) && name.endsWith(`_${n}`) && !WRITE_VERB.test(name.slice(0, -n.length - 1))));
    if (rank < 0) continue;
    // a prefixed match ("users_get_me") is a little less sure than the exact name
    const score = rank * 2 + (name === IDENTITY_NAMES[rank] ? 0 : 1);
    if (!best || score < best.rank) best = { tool, rank: score };
  }
  return best?.tool;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const EMAIL_KEYS = ["email", "emailaddress", "email_address", "mail", "primaryemail", "primary_email", "user_email"];
const LOGIN_KEYS = ["login", "username", "user_name", "preferred_username", "handle", "screen_name", "user"];
const NAME_KEYS = ["displayname", "display_name", "name", "real_name", "realname", "full_name", "fullname"];

/** The first string value under one of `keys` (depth-first, nested objects too). */
function find(value: unknown, keys: string[], test: (v: string) => boolean, depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 4) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [k, v] of entries) {
    if (typeof v === "string" && keys.includes(k.toLowerCase()) && v.trim() && test(v.trim())) return v.trim();
  }
  for (const [, v] of entries) {
    if (v && typeof v === "object") {
      const found = find(v, keys, test, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** The identity a whoami-like tool returned: an email, else a username / login, else a name. */
export function accountFromToolResult(result: Record<string, unknown> | undefined): string | undefined {
  if (!result || result.isError === true) return undefined;
  const payloads: unknown[] = [];
  if (result.structuredContent && typeof result.structuredContent === "object") payloads.push(result.structuredContent);
  const texts: string[] = [];
  for (const part of Array.isArray(result.content) ? result.content : []) {
    const text = (part as { type?: string; text?: unknown })?.type === "text" ? (part as { text?: unknown }).text : undefined;
    if (typeof text !== "string") continue;
    texts.push(text);
    try { payloads.push(JSON.parse(text)); } catch { /* plain text */ }
  }
  const clip = (v: string) => v.slice(0, 200);
  for (const p of payloads) {
    const email = find(p, EMAIL_KEYS, (v) => EMAIL.test(v));
    if (email) return clip(email);
  }
  for (const p of payloads) {
    const login = find(p, LOGIN_KEYS, (v) => v.length <= 100 && !/\s{2,}|\n/.test(v));
    if (login) return clip(login);
  }
  // plain text answers ("Logged in as ada@acme.com"): only an email is clear enough
  for (const t of texts) {
    const m = EMAIL.exec(t);
    if (m) return clip(m[0]);
  }
  for (const p of payloads) {
    const name = find(p, NAME_KEYS, (v) => v.length <= 100 && !/\n/.test(v));
    if (name) return clip(name);
  }
  return undefined;
}
