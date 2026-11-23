/**
 * Catalog of official REMOTE MCP servers people can connect with one click (Settings → Connectors,
 * or Polpo's connector_add). The data (catalog-data.ts) is generated from a verified list
 * (scripts/generate-connector-catalog.mjs); this module turns it into `ConnectorCatalogEntry`:
 *
 * - auth "oauth": dynamic client registration or a Client ID Metadata Document (nothing to set up);
 * - auth "oauth_preregistered": the admin registers an OAuth client with the vendor once and saves it
 *   as a shared OAuth app (`oauth.app`: "google" for every Google entry, else the entry id), reused
 *   by every connector of that vendor;
 * - Google: accounts.google.com as authorization server, structured scopes, access_type=offline and
 *   prompt=consent (so a refresh token is issued);
 * - per-account URLs (`urlTemplate`, e.g. https://mcp.dev.azure.com/{organization}) are filled in by
 *   the person; region / sandbox endpoints become `variants`.
 */
import type { ConnectorCatalogEntry, ConnectorIcon } from "@polpo-ai/core";
import { CATALOG_DATA } from "./catalog-data.js";

/** One entry of the generated catalog data, as published. */
export interface RawCatalogEntry {
  id: string;
  name: string;
  category: string;
  description: string;
  url: string;
  transport: string;
  auth: string;
  oauthRegistration?: string | null;
  authNotes?: string | null;
  urlTemplate?: boolean | string | null;
  docs?: string | null;
  domain?: string | null;
  inClaudeDirectory?: boolean;
  inLovable?: boolean;
  verified?: boolean;
  icon?: { simpleIcons?: string | null; svg?: string | null; png?: string | null } | null;
  brandColor?: string | null;
}

const G = "https://www.googleapis.com/auth/";

/** Google Workspace MCP servers (Developer Preview): one Web OAuth client, shared by all of them. */
export const GOOGLE_WORKSPACE_SETUP = [
  "Google's MCP servers need a Google Cloud OAuth client, set up once for all of them:",
  "1. In Google Cloud Console (APIs & Services → Credentials) create an OAuth client of type \"Web application\"; for Workspace servers enable \"Use this client for an AI-powered agent\".",
  "2. Add this instance's redirect URI to it: <public URL>/api/v1/connectors/oauth/callback (shown on the Connectors page).",
  "3. Enable the product API and its MCP API in the same project (e.g. Gmail API + gmailmcp.googleapis.com; Drive API + drivemcp.googleapis.com; Calendar API + calendarmcp.googleapis.com).",
  "4. Workspace MCP servers are a Developer Preview: the Google Cloud project must be enrolled.",
  "5. Save the client id and secret as the \"google\" OAuth app (Connectors → OAuth apps), then connect each service with one click.",
].join("\n");

const REDIRECT_PLACEHOLDER = "<public URL>/api/v1/connectors/oauth/callback";

/** User token scopes of the Slack MCP server's tools (search, messages, channels, canvases, lists…). */
export const SLACK_USER_SCOPES = [
  "search:read.public", "search:read.private", "search:read.mpim", "search:read.im", "search:read.files", "search:read.users",
  "emoji:read", "chat:write",
  "channels:history", "groups:history", "mpim:history", "im:history",
  "channels:write", "groups:write", "im:write", "mpim:write",
  "channels:read", "groups:read", "mpim:read",
  "files:read", "files:write", "users:read", "users:read.email",
  "reactions:write", "reactions:read", "canvases:read", "canvases:write", "lists:read", "lists:write",
];

/** Slack app manifest (api.slack.com/apps → Create New App → From a manifest), the redirect URL as a placeholder. */
export const SLACK_APP_MANIFEST = JSON.stringify({
  display_information: { name: "Polpo" },
  oauth_config: { redirect_urls: [REDIRECT_PLACEHOLDER], scopes: { user: SLACK_USER_SCOPES } },
}, null, 2);

/** Slack's MCP server: a Slack app of your own, with the MCP server feature turned on. */
export const SLACK_SETUP = [
  "Slack's MCP server needs a Slack app of your own (internal to your workspace, or published in the Slack Marketplace), set up once:",
  "1. At https://api.slack.com/apps choose Create New App → From a manifest, pick the workspace and paste the manifest shown here (the user token scopes and this instance's redirect URL are in it). Without a manifest: OAuth & Permissions → add the redirect URL " + REDIRECT_PLACEHOLDER + " and the user token scopes listed in the manifest.",
  "2. In the app's settings open Features → Agents and turn on \"Slack Model Context Protocol (MCP) Server\". Without it the first connection fails with \"App is not enabled for Slack MCP server access\".",
  "3. Install the app to the workspace (a workspace admin may have to approve it).",
  "4. From Basic Information → App Credentials save the Client ID and Client Secret as the \"slack\" OAuth app, then connect.",
].join("\n");

/** Canva's Connect MCP endpoint: a Canva app of your own with the MCP integration turned on. */
export const CANVA_SETUP = [
  "Canva's MCP server takes your own Canva app (Canva's public endpoint only accepts approved clients), set up once:",
  "1. In the Canva Developer Portal (https://www.canva.com/developers/integrations) create an integration and choose \"Outside Canva\" → Start integrating.",
  "2. Turn on \"Canva MCP\" and give it the scopes it lists (designs, folders, assets, comments, brand templates…).",
  "3. Under Redirect URLs add this instance's redirect URI: " + REDIRECT_PLACEHOLDER,
  "4. Under Configuration → Credentials copy the Client ID and generate a client secret; save both as the \"canva\" OAuth app (Connectors → OAuth apps), then connect.",
].join("\n");

/** Dropbox's MCP server: dynamic registration is for Dropbox's trusted partners only. */
export const DROPBOX_SETUP = [
  "Dropbox's MCP server takes your own Dropbox app (dynamic registration is limited to Dropbox's trusted partners), set up once:",
  "1. In the Dropbox App Console (https://www.dropbox.com/developers/apps) choose Create app → Scoped access → Full Dropbox.",
  "2. On Permissions tick files.metadata.read, files.content.read, files.content.write, sharing.read, sharing.write, account_info.read, file_requests.read and file_requests.write, then Submit.",
  "3. On Settings → OAuth 2 → Redirect URIs add this instance's redirect URI: " + REDIRECT_PLACEHOLDER,
  "4. Save the App key (client id) and App secret as the \"dropbox\" OAuth app (Connectors → OAuth apps), then connect.",
].join("\n");

/** Setup steps (an app manifest, extra OAuth parameters) of OAuth apps that need more than the generic steps. */
const VENDOR_SETUP: Record<string, { setup: string; manifest?: string; oauth?: Partial<NonNullable<ConnectorCatalogEntry["oauth"]>> }> = {
  slack: { setup: SLACK_SETUP, manifest: SLACK_APP_MANIFEST },
  canva: { setup: CANVA_SETUP },
  // a refresh token comes only with token_access_type=offline
  dropbox: { setup: DROPBOX_SETUP, oauth: { extraAuthParams: { token_access_type: "offline" } } },
};

/** API keys sent in a vendor header instead of Authorization: Bearer. */
const AUTH_HEADERS: Record<string, string> = {
  newrelic: "Api-Key",
  pipedrive: "x-api-token",
};

/**
 * Removed after the catalog health check (scripts/check-connector-catalog.mjs, 2026-11): their MCP
 * servers only accept clients the vendor approved (Claude, ChatGPT, Cursor…), with no app or token
 * route for a self-hosted client: whatsapp-business (Meta: "the server recognizes supported clients
 * automatically"), zoominfo (approved vendors), mollie (approved client_uri list), airwallex,
 * pitchbook and gamma (approved redirect URIs), mailchimp (a Claude-only endpoint).
 */

/**
 * OAuth quirks found by the catalog health check (scripts/check-connector-catalog.mjs):
 * semgrep: login.semgrep.dev answers every RFC 8707 resource indicator with invalid_target.
 */
const OAUTH_QUIRKS: Record<string, Partial<NonNullable<ConnectorCatalogEntry["oauth"]>>> = {
  semgrep: { resourceIndicator: false },
};

/** Fallback scopes when the notes do not list them. */
const GOOGLE_SCOPES: Record<string, string[]> = {
  gmail: ["gmail.readonly", "gmail.compose", "gmail.modify"],
  "google-drive": ["drive.readonly", "drive.file"],
  "google-calendar": ["calendar.calendarlist.readonly", "calendar.events.freebusy", "calendar.events.readonly", "calendar.events"],
  "google-docs": ["drive.readonly", "drive.file", "documents.readonly", "documents"],
  "google-sheets": ["drive.readonly", "drive.file", "spreadsheets.readonly", "spreadsheets"],
  "google-slides": ["drive.readonly", "drive.file", "presentations.readonly", "presentations"],
  "google-chat": ["chat.spaces.readonly", "chat.memberships.readonly", "chat.messages.readonly", "chat.messages.create"],
  "google-people": ["directory.readonly", "userinfo.profile", "contacts.readonly"],
  "google-workspace-search": ["gmail.readonly", "drive.readonly", "calendar.readonly", "chat.messages.readonly", "chat.spaces.readonly", "chat.memberships.readonly"],
};

function isGoogle(raw: RawCatalogEntry): boolean {
  return raw.category === "Google Workspace" || /^(google-|gcp-)/.test(raw.id) || raw.id === "bigquery"
    || /\.googleapis\.com$/.test(new URL(raw.url.replace(/\{[^}]*\}/g, "x")).hostname);
}

/** Google scopes from the notes ("Scopes: gmail.readonly, gmail.compose." / "Scope https://…/bigquery" / "cloud-platform scope"). */
function googleScopes(raw: RawCatalogEntry): string[] {
  const notes = raw.authNotes ?? "";
  const listed = /Scopes?:\s*(.+?)(?:\.\s|\.$|$)/i.exec(notes)?.[1];
  let scopes = listed
    ? listed.split(",").map((s) => s.replace(/\(.*?\)/g, "").trim()).filter((s) => /^[a-z][\w.]*$/.test(s))
    : [];
  const urls = notes.match(/https:\/\/www\.googleapis\.com\/auth\/[\w.]+/g);
  if (urls) scopes = [...scopes, ...urls.map((u) => u.slice(G.length).replace(/\.+$/, ""))];
  if (/cloud-platform/.test(notes)) scopes.push("cloud-platform");
  if (scopes.length === 0) scopes = GOOGLE_SCOPES[raw.id] ?? (raw.category === "Google Workspace" ? [] : ["cloud-platform"]);
  return [...new Set(scopes)].map((s) => `${G}${s}`);
}

const VARIANT = /\b(US\d?|EU\d?|CA|AU|IN|SG|AP\d|Sandbox|Demo)\s*:?\s+((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[\w/.-]*)?)/g;

/** Region / sandbox endpoints mentioned in the notes ("EU: mcp.eu.intercom.com/mcp", "US1 mcp.datadoghq.com"). */
function variants(raw: RawCatalogEntry): Array<{ label: string; url: string }> | undefined {
  const notes = raw.authNotes ?? "";
  if (raw.urlTemplate === true) return undefined;
  const base = new URL(raw.url);
  const found: Array<{ label: string; url: string }> = [];
  for (const [, label, target] of notes.matchAll(VARIANT)) {
    const clean = target!.replace(/[.,;]+$/, "");
    let url: URL;
    try {
      url = new URL(clean.startsWith("http") ? clean : `https://${clean}`);
    } catch {
      continue;
    }
    if (url.pathname === "/" && base.pathname !== "/") url.pathname = base.pathname;
    if (!found.some((v) => v.url === url.toString())) found.push({ label: label!, url: url.toString() });
  }
  const others = found.filter((v) => v.url !== base.toString());
  if (others.length === 0) return undefined;
  const defaultLabel = found.find((v) => v.url === base.toString())?.label ?? "Default";
  return [{ label: defaultLabel, url: base.toString() }, ...others];
}

function icon(raw: RawCatalogEntry): ConnectorIcon | undefined {
  if (!raw.icon && !raw.brandColor) return undefined;
  return {
    ...(raw.icon?.simpleIcons !== undefined ? { simpleIcons: raw.icon.simpleIcons } : {}),
    ...(raw.icon?.svg !== undefined ? { svg: raw.icon.svg } : {}),
    ...(raw.icon?.png !== undefined ? { png: raw.icon.png } : {}),
    ...(raw.brandColor ? { color: raw.brandColor } : {}),
  };
}

/** Turn a published entry into a catalog entry. */
export function normalizeCatalogEntry(raw: RawCatalogEntry): ConnectorCatalogEntry {
  const google = isGoogle(raw);
  const auth = (["oauth", "oauth_preregistered", "bearer", "none"].includes(raw.auth) ? raw.auth : "none") as ConnectorCatalogEntry["auth"];
  const template = raw.urlTemplate === true || /\{[^}]+\}/.test(raw.url);
  const entry: ConnectorCatalogEntry = {
    id: raw.id,
    name: raw.name,
    category: raw.category,
    description: raw.description,
    ...(template ? { urlTemplate: raw.url } : { url: raw.url }),
    transport: raw.transport === "sse" ? "sse" : "http",
    auth,
    ...(raw.oauthRegistration ? { oauthRegistration: raw.oauthRegistration as ConnectorCatalogEntry["oauthRegistration"] } : {}),
    ...(raw.authNotes ? { authNotes: raw.authNotes } : {}),
    ...(raw.docs ? { docs: raw.docs } : {}),
    ...(raw.domain ? { domain: raw.domain } : {}),
    ...(icon(raw) ? { icon: icon(raw) } : {}),
    ...(raw.inClaudeDirectory !== undefined ? { inClaudeDirectory: raw.inClaudeDirectory } : {}),
    ...(raw.inLovable !== undefined ? { inLovable: raw.inLovable } : {}),
    verified: raw.verified !== false,
  };
  const found = variants(raw);
  if (found) entry.variants = found;
  if (auth === "bearer" && /X-Goog-Api-Key/i.test(raw.authNotes ?? "")) entry.authHeader = "X-Goog-Api-Key";
  if (auth === "bearer" && AUTH_HEADERS[raw.id]) entry.authHeader = AUTH_HEADERS[raw.id];
  if (auth === "oauth" && OAUTH_QUIRKS[raw.id]) entry.oauth = { ...OAUTH_QUIRKS[raw.id] };
  if (auth === "oauth_preregistered") {
    if (google) {
      entry.oauth = {
        app: "google",
        authorizationServer: "https://accounts.google.com",
        scopes: googleScopes(raw),
        extraAuthParams: { access_type: "offline", prompt: "consent" },
      };
      entry.setup = GOOGLE_WORKSPACE_SETUP;
    } else if (VENDOR_SETUP[raw.id]) {
      entry.oauth = { app: raw.id, ...VENDOR_SETUP[raw.id]!.oauth };
      entry.setup = VENDOR_SETUP[raw.id]!.setup;
      if (VENDOR_SETUP[raw.id]!.manifest) entry.setupManifest = VENDOR_SETUP[raw.id]!.manifest;
    } else {
      entry.oauth = { app: raw.id };
      entry.setup = [
        `Use an OAuth app approved by ${raw.name} for its MCP server.`,
        raw.authNotes ? `Notes: ${raw.authNotes}` : "",
        "Use this instance's redirect URI: <public URL>/api/v1/connectors/oauth/callback (shown on the Connectors page).",
        `Save the client id and any issued secret as the "${raw.id}" OAuth app and connect.`,
      ].filter(Boolean).join("\n");
    }
  }
  return entry;
}

export const CONNECTOR_CATALOG: ConnectorCatalogEntry[] = CATALOG_DATA.map(normalizeCatalogEntry);

export function catalogEntry(id: string): ConnectorCatalogEntry | undefined {
  return CONNECTOR_CATALOG.find((entry) => entry.id === id);
}
