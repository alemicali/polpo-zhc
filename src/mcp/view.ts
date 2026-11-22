/**
 * What the API and Polpo show of a connector: its configuration (never a secret) plus which
 * secrets are set (names and booleans only).
 */
import type { ConnectorConfig } from "@polpo-ai/core";
import { SECRET_KEYS } from "./secrets.js";

export interface PublicConnector extends ConnectorConfig {
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
    secrets: {
      bearerToken: has(SECRET_KEYS.bearer),
      headers: secretKeys.filter((k) => k.startsWith("header:")).map((k) => k.slice("header:".length)),
      clientSecret: has(SECRET_KEYS.clientSecret),
      values: secretKeys.filter((k) => k.startsWith("secret:")).map((k) => k.slice("secret:".length)),
      oauth: { authorized: has(SECRET_KEYS.tokens), clientRegistered: has(SECRET_KEYS.clientInfo), pending: has(SECRET_KEYS.state) },
    },
  };
}
