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

const VARIANT = /\b(US\d?|EU\d?|AU|IN|SG|AP\d|Sandbox|Demo)\s*:?\s+((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[\w/.-]*)?)/g;

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
  if (auth === "oauth_preregistered") {
    if (google) {
      entry.oauth = {
        app: "google",
        authorizationServer: "https://accounts.google.com",
        scopes: googleScopes(raw),
        extraAuthParams: { access_type: "offline", prompt: "consent" },
      };
      entry.setup = GOOGLE_WORKSPACE_SETUP;
    } else {
      entry.oauth = { app: raw.id };
      entry.setup = [
        `${raw.name} does not let apps register themselves: register an OAuth app with ${raw.name} once${raw.docs ? ` (${raw.docs})` : ""}.`,
        raw.authNotes ? `Notes: ${raw.authNotes}` : "",
        "Use this instance's redirect URI: <public URL>/api/v1/connectors/oauth/callback (shown on the Connectors page).",
        `Then save its client id and secret as the "${raw.id}" OAuth app (Connectors → OAuth apps) and connect.`,
      ].filter(Boolean).join("\n");
    }
  }
  return entry;
}

export const CONNECTOR_CATALOG: ConnectorCatalogEntry[] = CATALOG_DATA.map(normalizeCatalogEntry);

export function catalogEntry(id: string): ConnectorCatalogEntry | undefined {
  return CONNECTOR_CATALOG.find((entry) => entry.id === id);
}
