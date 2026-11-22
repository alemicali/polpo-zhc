/**
 * A harness's credentials, resolved from the instance settings and the vault, explicitly. Nothing
 * comes from this server's environment or files (no ANTHROPIC_API_KEY / AWS_* / ~/.claude /
 * ~/.codex lookup): the settings point to a vault entry (owner + service) chosen by a person.
 */
import {
  CLAUDE_SUBSCRIPTION_REFUSAL, CREDENTIAL_NAMES, HARNESS_NAMES, pickCredential, resolveVaultRef,
  type AgentHarnessEngine, type HarnessesSettings, type VaultStore,
} from "@polpo-ai/core";
import type { HarnessAuth } from "./types.js";

export class HarnessCredentialError extends Error {
  constructor(message: string) { super(message); this.name = "HarnessCredentialError"; }
}

/** A file the runtime needs (Vertex service account): written under the session's HOME, its path in `envVar`. */
export interface HarnessCredentialFile { envVar: string; name: string; content: string }

export interface ResolvedHarnessAuth extends HarnessAuth {
  files: HarnessCredentialFile[];
  /** The model the runtime uses (agent's, else the harness setting's; undefined: the runtime's default). */
  model?: string;
  /** Where the model runs (error messages name it). */
  provider: "anthropic" | "bedrock" | "vertex" | "openai";
}

/** Claude subscription OAuth tokens (Pro/Max): refused by policy. */
const CLAUDE_OAUTH_TOKEN = /^sk-ant-oat/i;

/** Environment every Claude Code process gets (root VMs; no telemetry or self-update). */
const CLAUDE_CODE_BASE_ENV: Record<string, string> = {
  // the VM runs as root: Claude Code accepts bypassPermissions ("allow-all") only with IS_SANDBOX
  IS_SANDBOX: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
};

export async function resolveHarnessAuth(
  engine: AgentHarnessEngine,
  settings: HarnessesSettings | undefined,
  vault: VaultStore | undefined,
): Promise<ResolvedHarnessAuth> {
  const name = HARNESS_NAMES[engine.harness];
  if (!settings?.enabled.includes(engine.harness)) throw new HarnessCredentialError(`${name} is not enabled on this instance (Settings → Harnesses)`);
  const where = engine.harness === "claude-code" ? 'settings.harnesses["claude-code"]' : "settings.harnesses.codex";
  const h = settings[engine.harness];
  if (!h) throw new HarnessCredentialError(`${name} has no settings (${where})`);
  const creds = await resolveVaultRef(vault, h.credentialRef);
  if (!creds) throw new HarnessCredentialError(`${name}: the vault entry ${h.credentialRef.owner} / ${h.credentialRef.service} (${where}.credentialRef) is missing`);
  const model = engine.model ?? h.model;

  if (engine.harness === "codex") {
    const key = pickCredential(creds, ["OPENAI_API_KEY", "openaiApiKey", "CODEX_API_KEY", ...CREDENTIAL_NAMES.apiKey]);
    if (!key) throw new HarnessCredentialError(`Codex: the vault entry ${h.credentialRef.owner} / ${h.credentialRef.service} has no API key (a field named apiKey, key or OPENAI_API_KEY)`);
    return { auth: { OPENAI_API_KEY: key }, env: {}, secrets: [key], files: [], provider: "openai", ...(model ? { model } : {}) };
  }

  const cc = settings["claude-code"]!;
  if (cc.auth === "api-key") {
    const key = pickCredential(creds, ["ANTHROPIC_API_KEY", "anthropicApiKey", ...CREDENTIAL_NAMES.apiKey]);
    if (!key) throw new HarnessCredentialError(`Claude Code: the vault entry ${cc.credentialRef.owner} / ${cc.credentialRef.service} has no API key (a field named apiKey, key or ANTHROPIC_API_KEY)`);
    if (CLAUDE_OAUTH_TOKEN.test(key)) throw new HarnessCredentialError(`Claude Code: that vault entry holds a Claude subscription token. ${CLAUDE_SUBSCRIPTION_REFUSAL}`);
    return {
      auth: { ANTHROPIC_API_KEY: key },
      env: { ...CLAUDE_CODE_BASE_ENV, ...(model ? { ANTHROPIC_MODEL: model } : {}) },
      secrets: [key], files: [], provider: "anthropic", ...(model ? { model } : {}),
    };
  }

  if (cc.auth === "bedrock") {
    const region = cc.bedrock?.region;
    if (!region) throw new HarnessCredentialError("Claude Code on Bedrock needs settings.harnesses[\"claude-code\"].bedrock.region");
    const bearer = pickCredential(creds, ["AWS_BEARER_TOKEN_BEDROCK", "bearerToken", "bedrockApiKey", ...CREDENTIAL_NAMES.apiKey]);
    const accessKeyId = pickCredential(creds, [...CREDENTIAL_NAMES.accessKeyId]);
    const secretAccessKey = pickCredential(creds, [...CREDENTIAL_NAMES.secretAccessKey]);
    const sessionToken = pickCredential(creds, [...CREDENTIAL_NAMES.sessionToken]);
    const env: Record<string, string> = { ...CLAUDE_CODE_BASE_ENV, CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: region };
    const secrets: string[] = [];
    if (accessKeyId && secretAccessKey) {
      env.AWS_ACCESS_KEY_ID = accessKeyId;
      env.AWS_SECRET_ACCESS_KEY = secretAccessKey;
      if (sessionToken) env.AWS_SESSION_TOKEN = sessionToken;
      secrets.push(secretAccessKey, ...(sessionToken ? [sessionToken] : []));
    } else if (bearer) {
      env.AWS_BEARER_TOKEN_BEDROCK = bearer;
      secrets.push(bearer);
    } else {
      throw new HarnessCredentialError(`Claude Code on Bedrock: the vault entry ${cc.credentialRef.owner} / ${cc.credentialRef.service} needs a Bedrock API key (apiKey / AWS_BEARER_TOKEN_BEDROCK) or accessKeyId + secretAccessKey`);
    }
    if (model) {
      env.ANTHROPIC_MODEL = model;
      // a Haiku model id is also the small/fast model (otherwise Claude Code's Bedrock default)
      if (/haiku/i.test(model)) { env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model; env.ANTHROPIC_SMALL_FAST_MODEL = model; }
    }
    // auth {} = an explicit, empty authentication environment: no lookup on this server
    return { auth: {}, env, secrets, files: [], provider: "bedrock", ...(model ? { model } : {}) };
  }

  // vertex
  const v = cc.vertex;
  if (!v) throw new HarnessCredentialError("Claude Code on Vertex AI needs settings.harnesses[\"claude-code\"].vertex { region, projectId }");
  const json = pickCredential(creds, ["serviceAccountJson", "service_account_json", "GOOGLE_APPLICATION_CREDENTIALS", "credentialsJson", "json", "credentials"]);
  if (!json || !json.trim().startsWith("{")) throw new HarnessCredentialError(`Claude Code on Vertex AI: the vault entry ${cc.credentialRef.owner} / ${cc.credentialRef.service} needs a service account key (JSON) in a field named serviceAccountJson`);
  const env: Record<string, string> = {
    ...CLAUDE_CODE_BASE_ENV, CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: v.region, ANTHROPIC_VERTEX_PROJECT_ID: v.projectId,
    ...(model ? { ANTHROPIC_MODEL: model } : {}),
  };
  let privateKey: string | undefined;
  try { privateKey = (JSON.parse(json) as { private_key?: string }).private_key; } catch { /* checked by Google */ }
  return {
    auth: {}, env, secrets: [json, ...(privateKey ? [privateKey] : [])],
    files: [{ envVar: "GOOGLE_APPLICATION_CREDENTIALS", name: "vertex-service-account.json", content: json }],
    provider: "vertex",
    ...(model ? { model } : {}),
  };
}

/** Text with every secret replaced (transcripts, errors, logs). */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("<redacted>");
  return out;
}
