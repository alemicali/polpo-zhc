/**
 * Gateways: the hosted AI gateways Polpo can call for model families that are not chat models
 * (decisions and images today). One resolver turns a gateway's name into where requests go and how they
 * authenticate:
 *
 *   name → base URL, the hosts the key may be sent to, the key (a vault entry chosen in the
 *   settings, else the gateway's own environment variable), the request headers.
 *
 * Nothing new is configured here: the gateways are the custom-provider presets of kind "gateway"
 * with a fixed official host (provider-presets.ts: PROVIDER_PRESETS, GATEWAY_ENV_HOSTS), and the
 * key follows the vault-reference convention every other feature uses (vault-ref.ts). The harness
 * gateway settings (harnesses.ts) and custom providers still resolve their own; they can move onto
 * this resolver later.
 */
import { GATEWAY_ENV_HOSTS, PROVIDER_PRESETS, hostMatches } from "./provider-presets.js";
import { CREDENTIAL_NAMES, describeVaultRef, isVaultRef, pickCredential, resolveVaultRef, type VaultRef } from "./vault-ref.js";
import type { VaultStore } from "./vault-store.js";

/** What a gateway can be used for beyond chat. */
export type GatewayCapability = "decisions" | "images";

export interface GatewayDefinition {
  /** The preset id, e.g. "vercel-ai-gateway". */
  id: string;
  label: string;
  /** The API base, e.g. https://ai-gateway.vercel.sh/v1. */
  baseUrl: string;
  /** The environment variable holding the key when no vault entry is chosen. */
  envVar: string;
  /** The only hosts the key may be sent to (a leading "." means any subdomain). */
  allowedHosts: string[];
  capabilities: GatewayCapability[];
  docsUrl?: string;
}

/** Capabilities per gateway (the rest are chat-only, through custom providers). */
const CAPABILITIES: Record<string, GatewayCapability[]> = {
  "vercel-ai-gateway": ["decisions", "images"],
};

/** The gateways: presets of kind "gateway" with a fixed official host and an env var bound to it. */
export const GATEWAYS: readonly GatewayDefinition[] = PROVIDER_PRESETS
  .filter((p) => p.kind === "gateway" && !p.baseUrl.includes("{") && !!p.auth.envVar && !!GATEWAY_ENV_HOSTS[p.auth.envVar])
  .map((p) => ({
    id: p.id, label: p.label, baseUrl: p.baseUrl, envVar: p.auth.envVar!, allowedHosts: GATEWAY_ENV_HOSTS[p.auth.envVar!],
    capabilities: CAPABILITIES[p.id] ?? [], ...(p.docsUrl ? { docsUrl: p.docsUrl } : {}),
  }));

export function gatewayDefinition(id: string): GatewayDefinition | undefined {
  return GATEWAYS.find((g) => g.id === id);
}

/** The gateways that offer a capability. */
export function gatewaysWith(capability: GatewayCapability): GatewayDefinition[] {
  return GATEWAYS.filter((g) => g.capabilities.includes(capability));
}

/** Where a gateway's key is: a vault entry (owner + service, optionally one field), else the gateway's env var. */
export interface GatewayCredential {
  credentialRef?: VaultRef;
  /** The field of the vault entry holding the key (default: apiKey, key, token…). */
  credentialField?: string;
}

export type GatewayErrorCode = "unknown_gateway" | "unsupported" | "no_key" | "vault_missing" | "vault_field" | "host_not_allowed";

export class GatewayError extends Error {
  constructor(message: string, readonly code: GatewayErrorCode) { super(message); this.name = "GatewayError"; }
}

export interface ResolvedGateway {
  id: string;
  label: string;
  baseUrl: string;
  allowedHosts: string[];
  /** The key: never logged, returned or put in an error. */
  key: string;
  /** Where the key came from (shown to people instead of the key). */
  keySource: { kind: "vault"; ref: VaultRef; field?: string } | { kind: "env"; envVar: string };
  /** Authentication headers for the gateway. */
  headers: Record<string, string>;
}

export interface ResolveGatewayOptions {
  vault?: VaultStore | null;
  /** The environment the env var fallback reads (default process.env). */
  env?: Record<string, string | undefined>;
  /** Refuse a gateway without this capability. */
  capability?: GatewayCapability;
}

/**
 * Resolve a gateway: its definition, its key (the vault entry when one is chosen, else the env
 * var) and the headers. A chosen vault entry that is missing is an error: the env var is only the
 * fallback when no entry is chosen, so a person's choice is never silently replaced.
 */
export async function resolveGateway(id: string, credential: GatewayCredential = {}, opts: ResolveGatewayOptions = {}): Promise<ResolvedGateway> {
  const def = gatewayDefinition(id);
  if (!def) throw new GatewayError(`Unknown gateway "${id}" (known: ${GATEWAYS.map((g) => g.id).join(", ")})`, "unknown_gateway");
  if (opts.capability && !def.capabilities.includes(opts.capability)) {
    const offering = gatewaysWith(opts.capability).map((g) => g.id).join(", ") || "none";
    throw new GatewayError(`${def.label} does not offer ${opts.capability} through Polpo (gateways that do: ${offering})`, "unsupported");
  }
  let key: string | undefined;
  let keySource: ResolvedGateway["keySource"];
  if (isVaultRef(credential.credentialRef)) {
    const ref = credential.credentialRef;
    const creds = await resolveVaultRef(opts.vault, ref);
    if (!creds) throw new GatewayError(`${def.label}: the vault entry ${describeVaultRef(ref)} is missing`, "vault_missing");
    const field = credential.credentialField?.trim();
    key = field ? pickCredential(creds, [field]) : pickCredential(creds, [...CREDENTIAL_NAMES.apiKey]);
    if (!key) {
      throw new GatewayError(`${def.label}: the vault entry ${describeVaultRef(ref)} has no ${field ? `field "${field}"` : "key (a field named apiKey, key or token)"}`, "vault_field");
    }
    keySource = { kind: "vault", ref: { owner: ref.owner, service: ref.service }, ...(field ? { field } : {}) };
  } else {
    const env = opts.env ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    key = env[def.envVar]?.trim() || undefined;
    if (!key) throw new GatewayError(`${def.label}: no key — choose a vault entry in the settings or set ${def.envVar}`, "no_key");
    keySource = { kind: "env", envVar: def.envVar };
  }
  return {
    id: def.id, label: def.label, baseUrl: def.baseUrl.replace(/\/+$/, ""), allowedHosts: def.allowedHosts,
    key, keySource, headers: { authorization: `Bearer ${key}` },
  };
}

/** A gateway URL for a path, refused when its host is not one the key may go to. */
export function gatewayUrl(gateway: Pick<ResolvedGateway, "baseUrl" | "allowedHosts" | "label">, path: string): string {
  const url = `${gateway.baseUrl}/${path.replace(/^\/+/, "")}`;
  assertGatewayHost(url, gateway.allowedHosts, gateway.label);
  return url;
}

/** Throw unless the URL is https on one of the allowed hosts. */
export function assertGatewayHost(url: string, allowedHosts: string[], label = "The gateway"): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new GatewayError(`${label}: invalid URL`, "host_not_allowed"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !hostMatches(parsed.hostname, allowedHosts)) {
    throw new GatewayError(`${label}: requests may only go to https://${allowedHosts.join(", ")}`, "host_not_allowed");
  }
}

/** Where a gateway key comes from, in words (never the key). */
export function describeGatewayKey(source: ResolvedGateway["keySource"]): string {
  return source.kind === "vault" ? `vault ${describeVaultRef(source.ref)}${source.field ? ` (${source.field})` : ""}` : `env ${source.envVar}`;
}
