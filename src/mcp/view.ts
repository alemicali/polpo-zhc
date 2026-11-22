/**
 * What the API and Polpo show of a connector: its configuration (never a secret) plus which
 * secrets are set (names and booleans only).
 */
import type { ConnectorConfig } from "@polpo-ai/core";
import { CATALOG_ICON_FILES } from "./catalog-icons.generated.js";
import { SECRET_KEYS } from "./secrets.js";

export interface PublicConnector extends ConnectorConfig {
  /**
   * The connector's icon, relative to the instance: a catalog connector's bundled official icon
   * (/connector-icons/<catalogId>.<ext>, a public dashboard asset), else a custom connector's stored one
   * (/api/v1/connectors/<id>/icon?v=<hash>, authenticated like the rest of the API). Absent: letter tile.
   */
  iconUrl?: string;
  /** A custom connector's variant for dark backgrounds, when the MCP server gave one. */
  iconDarkUrl?: string;
  secrets: {
    bearerToken: boolean;
    headers: string[];
    clientSecret: boolean;
    values: string[];
    oauth: { authorized: boolean; clientRegistered: boolean; pending: boolean };
  };
}

export function publicConnector(connector: ConnectorConfig, secretKeys: string[]): PublicConnector {
  const has = (k: string) => secretKeys.includes(k);
  return {
    ...connector,
    ...connectorIconUrls(connector),
    secrets: {
      bearerToken: has(SECRET_KEYS.bearer),
      headers: secretKeys.filter((k) => k.startsWith("header:")).map((k) => k.slice("header:".length)),
      clientSecret: has(SECRET_KEYS.clientSecret),
      values: secretKeys.filter((k) => k.startsWith("secret:")).map((k) => k.slice("secret:".length)),
      oauth: { authorized: has(SECRET_KEYS.tokens), clientRegistered: has(SECRET_KEYS.clientInfo), pending: has(SECRET_KEYS.state) },
    },
  };
}

/** Where a connector's icon is served (see PublicConnector.iconUrl). */
export function connectorIconUrls(connector: Pick<ConnectorConfig, "id" | "catalogId" | "iconAsset">): { iconUrl?: string; iconDarkUrl?: string } {
  if (connector.catalogId) {
    const ext = CATALOG_ICON_FILES[connector.catalogId];
    return ext ? { iconUrl: `/connector-icons/${connector.catalogId}.${ext}` } : {};
  }
  const asset = connector.iconAsset;
  if (!asset) return {};
  const base = `/api/v1/connectors/${encodeURIComponent(connector.id)}/icon`;
  return { iconUrl: `${base}?v=${asset.hash}`, ...(asset.dark ? { iconDarkUrl: `${base}?theme=dark&v=${asset.dark.hash}` } : {}) };
}

/**
 * How a connector is named to the model and in lists: its display name, plus the signed-in account
 * when the name does not already say it ("Gmail 2 – info@acme.com"). Several accounts of the same
 * app (gmail, gmail-2…) are told apart by this and by their id.
 */
export function connectorLabel(connector: Pick<ConnectorConfig, "name" | "account">): string {
  const account = connector.account?.trim();
  return account && !connector.name.toLowerCase().includes(account.toLowerCase()) ? `${connector.name} – ${account}` : connector.name;
}

/**
 * The account an OpenID id_token names (email, else preferred_username), when the token endpoint
 * returned one. Read without verifying the signature: it came straight from the token endpoint over
 * TLS and only labels the connector, it never grants anything.
 */
export function accountFromIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const value = [claims.email, claims.preferred_username].find((v) => typeof v === "string" && v.trim());
    return typeof value === "string" ? value.trim().slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}
