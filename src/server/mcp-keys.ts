/**
 * Keys that open Polpo's MCP connector (/mcp and its consent page), each with its scopes:
 *
 * - the server's API keys: every scope (they open the whole REST API anyway);
 * - POLPO_MCP_KEY (comma-separated), the legacy MCP key: POLPO_MCP_KEY_SCOPES when set, else every
 *   scope, as before scopes existed, with a warning that recommends narrowing it;
 * - settings.mcp.keys: named keys kept in the vault ({ name, keyRef: { owner, service }, scopes }),
 *   read and work when they name no scope.
 *
 * Values never leave this module: the dashboard sees names, sources and scopes.
 */
import { timingSafeEqual } from "node:crypto";
import { CREDENTIAL_NAMES, describeVaultRef, pickCredential, resolveVaultRef, type VaultRef } from "@polpo-ai/core/vault-ref";
import type { VaultStore } from "@polpo-ai/core/vault-store";
import { ALL_SCOPES, DEFAULT_SCOPES, normalizeScopes, type PolpoScope } from "./mcp-server/kit.js";
export { parseMcpKeyConfigs } from "../core/config.js";

/** settings.mcp.keys[]: a named MCP key whose value is in the vault. */
export interface McpKeyConfig {
  name: string;
  keyRef: VaultRef;
  /** Scope names (see SCOPES); default read and work. */
  scopes?: string[];
}

export type McpKeySource = "api-key" | "env" | "settings";

/** A key that opens /mcp, without its value. */
export interface McpKeyInfo {
  name: string;
  source: McpKeySource;
  scopes: PolpoScope[];
  /** The scopes were set explicitly (POLPO_MCP_KEY_SCOPES, settings), not the back-compat default. */
  explicit: boolean;
  /** settings keys: where the value is (owner / service). */
  ref?: string;
  /** Why the key does not work (its vault entry is missing…). */
  problem?: string;
}

interface McpKey extends McpKeyInfo {
  value?: string;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The key a request carries: X-API-Key, or Authorization: Bearer. */
export function presentedKey(req: Request): string | undefined {
  const auth = req.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;
  return req.headers.get("x-api-key") ?? bearer ?? undefined;
}

export interface McpKeyRingSources {
  apiKeys: () => readonly string[];
  env: () => NodeJS.ProcessEnv;
  settings: () => McpKeyConfig[] | undefined;
  vault: () => VaultStore | undefined | null;
  warn?: (message: string) => void;
}

/** How long resolved vault values are kept (a changed key works within this time). */
const CACHE_MS = 30_000;

export class McpKeyRing {
  private cache?: { at: number; signature: string; keys: McpKey[] };
  private warned = false;

  constructor(private readonly sources: McpKeyRingSources) {}

  private async load(): Promise<McpKey[]> {
    const env = this.sources.env();
    const settings = this.sources.settings() ?? [];
    const signature = JSON.stringify([this.sources.apiKeys(), env.POLPO_MCP_KEY ?? "", env.POLPO_MCP_KEY_SCOPES ?? "", settings]);
    if (this.cache && this.cache.signature === signature && Date.now() - this.cache.at < CACHE_MS) return this.cache.keys;
    const keys: McpKey[] = [];
    this.sources.apiKeys().forEach((value, i) => keys.push({ name: i === 0 ? "API key" : `API key ${i + 1}`, source: "api-key", scopes: [...ALL_SCOPES], explicit: false, value }));
    const legacy = (env.POLPO_MCP_KEY ?? "").split(",").map((k) => k.trim()).filter(Boolean);
    if (legacy.length) {
      const configured = normalizeScopes(env.POLPO_MCP_KEY_SCOPES);
      const explicit = configured.length > 0;
      if (!explicit && !this.warned) {
        this.warned = true;
        this.sources.warn?.("POLPO_MCP_KEY has every scope (admin included), as before scopes existed. Narrow it with "
          + "POLPO_MCP_KEY_SCOPES=\"polpo:read polpo:work\" (add only the areas it needs), or use named keys in settings.mcp.keys.");
      }
      legacy.forEach((value, i) => keys.push({
        name: legacy.length > 1 ? `POLPO_MCP_KEY ${i + 1}` : "POLPO_MCP_KEY", source: "env",
        scopes: explicit ? configured : [...ALL_SCOPES], explicit, value,
      }));
    }
    const store = this.sources.vault();
    for (const k of settings) {
      const scopes = normalizeScopes(k.scopes);
      const credentials = await resolveVaultRef(store, k.keyRef).catch(() => undefined);
      const value = pickCredential(credentials, [...CREDENTIAL_NAMES.apiKey]);
      keys.push({
        name: k.name, source: "settings", scopes: scopes.length ? scopes : [...DEFAULT_SCOPES], explicit: scopes.length > 0,
        ref: describeVaultRef(k.keyRef), value,
        ...(value ? {} : { problem: `No key found in the vault entry ${describeVaultRef(k.keyRef)}` }),
      });
    }
    this.cache = { at: Date.now(), signature, keys };
    return keys;
  }

  /** The key a request (or a value typed on the consent page) matches, without its value; undefined when none. */
  async match(input: Request | string | undefined): Promise<McpKeyInfo | undefined> {
    const presented = typeof input === "string" ? input : input ? presentedKey(input) : undefined;
    if (!presented) return undefined;
    const keys = await this.load();
    const found = keys.find((k) => k.value && safeEqual(k.value, presented));
    return found ? strip(found) : undefined;
  }

  /** Is any key configured (a server with none, and no login, is open)? */
  async any(): Promise<boolean> {
    return (await this.load()).some((k) => !!k.value);
  }

  /** The keys for the dashboard: names, sources, scopes, never values. */
  async list(): Promise<McpKeyInfo[]> {
    return (await this.load()).map(strip);
  }
}

function strip(k: McpKey): McpKeyInfo {
  const { value: _value, ...info } = k;
  return info;
}
