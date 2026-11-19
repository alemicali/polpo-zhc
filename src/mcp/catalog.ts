/**
 * Catalog of well-known REMOTE MCP servers people can connect with one click (Settings →
 * Connectors, or Polpo's connector_add). Entries follow `ConnectorCatalogEntry`, the same shape
 * as the generated catalog JSON ({id, name, category, description, url | urlTemplate, transport,
 * auth, authNotes, docs, domain, verified}), so a larger list can be dropped in later.
 *
 * auth: "oauth" = OAuth with dynamic client registration (nothing to set up); "oauth_preregistered" =
 * the person registers an OAuth client with the vendor once (a shared `oauth.app`, e.g. "google",
 * reused by every Google entry); "bearer" = an API token; "none".
 *
 * `verified: false` marks endpoints not confirmed against the vendor's documentation.
 */
import type { ConnectorCatalogEntry } from "@polpo-ai/core";

const G = "https://www.googleapis.com/auth/";
const gScopes = (...names: string[]) => names.map((n) => `${G}${n}`);

/** Google Workspace MCP servers (Developer Preview): one Web OAuth client, shared by all of them. */
export const GOOGLE_WORKSPACE_SETUP = [
  "Google Workspace MCP servers (Developer Preview) need a Google Cloud OAuth client, set up once for all of them:",
  "1. In Google Cloud Console (APIs & Services → Credentials) create an OAuth client of type \"Web application\" and enable \"Use this client for an AI-powered agent\".",
  "2. Add this instance's redirect URI to it: <public URL>/api/v1/connectors/oauth/callback (shown on the Connectors page).",
  "3. Enable the product API and its MCP API in the same project (e.g. Gmail API + gmailmcp.googleapis.com; Drive API + drivemcp.googleapis.com; Calendar API + calendarmcp.googleapis.com).",
  "4. Your Google Cloud project must be in the Workspace MCP Developer Preview.",
  "5. Save the client id and secret as the \"google\" OAuth app in Polpo (Connectors → Google OAuth app), then connect each service.",
].join("\n");

const google = (id: string, name: string, description: string, host: string, scopes: string[]): ConnectorCatalogEntry => ({
  id, name, category: "Google Workspace", description,
  url: `https://${host}/mcp/v1`,
  transport: "http",
  auth: "oauth_preregistered",
  authNotes: "Uses the shared \"google\" OAuth app (a Web OAuth client with \"Use this client for an AI-powered agent\").",
  oauth: {
    app: "google",
    authorizationServer: "https://accounts.google.com",
    scopes,
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  docs: "https://developers.google.com/workspace/guides/configure-mcp-servers",
  domain: "google.com",
  icon: { simpleIcons: "google" },
  verified: true,
  setup: GOOGLE_WORKSPACE_SETUP,
});

export const CONNECTOR_CATALOG: ConnectorCatalogEntry[] = [
  // ── Google Workspace (pre-registered OAuth app "google") ──
  google("gmail", "Gmail", "Search, read and draft email, manage labels.", "gmailmcp.googleapis.com",
    gScopes("gmail.readonly", "gmail.compose", "gmail.modify")),
  google("google-drive", "Google Drive", "Search and read files in Drive, create files.", "drivemcp.googleapis.com",
    gScopes("drive.readonly", "drive.file")),
  google("google-calendar", "Google Calendar", "Read calendars and events, find free time, create and update events.", "calendarmcp.googleapis.com",
    gScopes("calendar.calendarlist.readonly", "calendar.events.freebusy", "calendar.events.readonly", "calendar.events")),
  google("google-docs", "Google Docs", "Read and write Google Docs.", "docsmcp.googleapis.com",
    gScopes("drive.readonly", "drive.file", "documents.readonly", "documents")),
  google("google-sheets", "Google Sheets", "Read and write spreadsheets.", "sheetsmcp.googleapis.com",
    gScopes("drive.readonly", "drive.file", "spreadsheets.readonly", "spreadsheets")),
  google("google-slides", "Google Slides", "Read and write presentations.", "slidesmcp.googleapis.com",
    gScopes("drive.readonly", "drive.file", "presentations.readonly", "presentations")),
  google("google-chat", "Google Chat", "Read spaces and messages, send messages.", "chatmcp.googleapis.com",
    gScopes("chat.spaces.readonly", "chat.memberships.readonly", "chat.messages.readonly", "chat.messages.create")),
  google("google-people", "Google People", "Look up contacts and the directory.", "people.googleapis.com",
    gScopes("directory.readonly", "userinfo.profile", "contacts.readonly")),
  google("google-workspace-search", "Google Workspace Search", "Search across Gmail, Drive, Calendar and Chat at once.", "workspacemcp.googleapis.com",
    gScopes("gmail.readonly", "drive.readonly", "calendar.readonly", "chat.messages.readonly", "chat.spaces.readonly", "chat.memberships.readonly")),

  // ── Project management & docs ──
  { id: "linear", name: "Linear", category: "Project management", description: "Issues, projects, cycles and comments in Linear.",
    url: "https://mcp.linear.app/mcp", transport: "http", auth: "oauth", docs: "https://linear.app/docs/mcp", domain: "linear.app", icon: { simpleIcons: "linear" }, verified: true },
  { id: "notion", name: "Notion", category: "Docs & knowledge", description: "Search, read and edit Notion pages and databases.",
    url: "https://mcp.notion.com/mcp", transport: "http", auth: "oauth", docs: "https://developers.notion.com/docs/mcp", domain: "notion.so", icon: { simpleIcons: "notion" }, verified: true },
  { id: "atlassian", name: "Atlassian (Jira & Confluence)", category: "Project management", description: "Jira issues and Confluence pages.",
    url: "https://mcp.atlassian.com/v1/sse", transport: "sse", auth: "oauth", docs: "https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/", domain: "atlassian.com", icon: { simpleIcons: "atlassian" }, verified: true },
  { id: "asana", name: "Asana", category: "Project management", description: "Tasks, projects and goals in Asana.",
    url: "https://mcp.asana.com/sse", transport: "sse", auth: "oauth", docs: "https://developers.asana.com/docs/using-asanas-mcp-server", domain: "asana.com", icon: { simpleIcons: "asana" }, verified: false },
  { id: "monday", name: "monday.com", category: "Project management", description: "Boards, items and updates in monday.com.",
    url: "https://mcp.monday.com/sse", transport: "sse", auth: "oauth", docs: "https://developer.monday.com/apps/docs/mondaycom-mcp-integration", domain: "monday.com", icon: { simpleIcons: "mondaydotcom" }, verified: false },
  { id: "box", name: "Box", category: "Docs & knowledge", description: "Search and read files in Box.",
    url: "https://mcp.box.com", transport: "http", auth: "oauth", docs: "https://developer.box.com/guides/box-mcp/", domain: "box.com", icon: { simpleIcons: "box" }, verified: false },

  // ── Engineering ──
  { id: "github", name: "GitHub", category: "Engineering", description: "Repositories, issues, pull requests and Actions.",
    url: "https://api.githubcopilot.com/mcp/", transport: "http", auth: "bearer",
    authNotes: "A GitHub personal access token (fine-grained: pick the repositories and permissions). OAuth works only with a pre-registered GitHub OAuth app.",
    docs: "https://github.com/github/github-mcp-server", domain: "github.com", icon: { simpleIcons: "github" }, verified: true },
  { id: "sentry", name: "Sentry", category: "Engineering", description: "Issues, errors and releases in Sentry.",
    url: "https://mcp.sentry.dev/mcp", transport: "http", auth: "oauth", docs: "https://docs.sentry.io/product/sentry-mcp/", domain: "sentry.io", icon: { simpleIcons: "sentry" }, verified: true },
  { id: "vercel", name: "Vercel", category: "Engineering", description: "Projects, deployments and logs on Vercel.",
    url: "https://mcp.vercel.com", transport: "http", auth: "oauth", docs: "https://vercel.com/docs/mcp/vercel-mcp", domain: "vercel.com", icon: { simpleIcons: "vercel" }, verified: true },
  { id: "cloudflare-docs", name: "Cloudflare Docs", category: "Engineering", description: "Search Cloudflare's documentation.",
    url: "https://docs.mcp.cloudflare.com/mcp", transport: "http", auth: "none", docs: "https://github.com/cloudflare/mcp-server-cloudflare", domain: "cloudflare.com", icon: { simpleIcons: "cloudflare" }, verified: true },
  { id: "supabase", name: "Supabase", category: "Engineering", description: "Projects, databases, SQL and edge functions on Supabase.",
    url: "https://mcp.supabase.com/mcp", transport: "http", auth: "oauth", docs: "https://supabase.com/docs/guides/getting-started/mcp", domain: "supabase.com", icon: { simpleIcons: "supabase" }, verified: true },
  { id: "neon", name: "Neon", category: "Engineering", description: "Neon Postgres projects, branches and SQL.",
    url: "https://mcp.neon.tech/mcp", transport: "http", auth: "oauth", docs: "https://neon.com/docs/ai/neon-mcp-server", domain: "neon.tech", icon: { simpleIcons: "neon" }, verified: true },
  { id: "huggingface", name: "Hugging Face", category: "Engineering", description: "Search models, datasets, Spaces and papers.",
    url: "https://huggingface.co/mcp", transport: "http", auth: "oauth", docs: "https://huggingface.co/settings/mcp", domain: "huggingface.co", icon: { simpleIcons: "huggingface" }, verified: true },

  // ── Payments & business ──
  { id: "stripe", name: "Stripe", category: "Payments", description: "Customers, payments, invoices and Stripe docs.",
    url: "https://mcp.stripe.com", transport: "http", auth: "oauth", docs: "https://docs.stripe.com/mcp", domain: "stripe.com", icon: { simpleIcons: "stripe" }, verified: true },
  { id: "paypal", name: "PayPal", category: "Payments", description: "Invoices, orders and transactions on PayPal.",
    url: "https://mcp.paypal.com/mcp", transport: "http", auth: "oauth", docs: "https://developer.paypal.com/tools/mcp-server/", domain: "paypal.com", icon: { simpleIcons: "paypal" }, verified: false },
  { id: "square", name: "Square", category: "Payments", description: "Payments, catalog, orders and customers on Square.",
    url: "https://mcp.squareup.com/sse", transport: "sse", auth: "oauth", docs: "https://developer.squareup.com/docs/mcp", domain: "squareup.com", icon: { simpleIcons: "square" }, verified: false },
  { id: "intercom", name: "Intercom", category: "Customer support", description: "Conversations and contacts in Intercom.",
    url: "https://mcp.intercom.com/mcp", transport: "http", auth: "oauth", docs: "https://developers.intercom.com/docs/guides/mcp", domain: "intercom.com", icon: { simpleIcons: "intercom" }, verified: false },

  // ── Design & web ──
  { id: "canva", name: "Canva", category: "Design", description: "Search, create and export Canva designs.",
    url: "https://mcp.canva.com/mcp", transport: "http", auth: "oauth", docs: "https://www.canva.dev/docs/connect/canva-mcp-server-setup/", domain: "canva.com", icon: { simpleIcons: "canva" }, verified: false },
  { id: "webflow", name: "Webflow", category: "Design", description: "Sites, CMS collections and pages on Webflow.",
    url: "https://mcp.webflow.com/sse", transport: "sse", auth: "oauth", docs: "https://developers.webflow.com/mcp/reference/overview", domain: "webflow.com", icon: { simpleIcons: "webflow" }, verified: false },

  // ── Automation ──
  { id: "zapier", name: "Zapier", category: "Automation", description: "Run the actions you enabled in your Zapier MCP server.",
    urlTemplate: "https://mcp.zapier.com/api/mcp/s/<your-secret>/mcp", transport: "http", auth: "none",
    authNotes: "Custom URL from your Zapier account (mcp.zapier.com): the URL itself is the secret, keep it private.",
    docs: "https://zapier.com/mcp", domain: "zapier.com", icon: { simpleIcons: "zapier" }, verified: true },
];

export function catalogEntry(id: string): ConnectorCatalogEntry | undefined {
  return CONNECTOR_CATALOG.find((entry) => entry.id === id);
}
