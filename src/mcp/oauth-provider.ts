/**
 * The MCP SDK's OAuthClientProvider backed by the vault (`$connectors`): discovery state, the
 * registered client (DCR) or a pre-registered one (connector clientId, or a shared OAuth app such
 * as "google"), tokens, the PKCE verifier and the single-use state of a pending authorization.
 *
 * Interactive mode (POST /connectors/:id/oauth/start) captures the authorization URL the SDK builds
 * (plus provider-specific parameters, e.g. Google's access_type=offline&prompt=consent). In
 * non-interactive mode (tool calls) a needed authorization only marks `authorizationRequired`; the
 * SDK then throws UnauthorizedError and the manager marks the connector "needs_reauth".
 */
import { randomBytes } from "node:crypto";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { OAuthClientMetadataSchema, type OAuthClientInformationMixed, type OAuthClientMetadata, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { ConnectorConfig } from "@polpo-ai/core";
import { OAuthHttpError, type OAuthStep } from "./oauth-errors.js";
import { SECRET_KEYS, type ConnectorSecrets } from "./secrets.js";

export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export interface PreregisteredClient {
  clientId: string;
  clientSecret?: string;
}

export interface VaultOAuthProviderOptions {
  /** Where the browser comes back (the instance's /api/v1/connectors/oauth/callback). */
  redirectUrl?: string;
  interactive: boolean;
  /** A pre-registered client (connector clientId, or the shared OAuth app). */
  preregistered?: PreregisteredClient;
  /**
   * This instance's Client ID Metadata Document (https only): servers that advertise
   * client_id_metadata_document_supported take this URL as client_id (no registration); the others
   * get a dynamic registration.
   */
  clientMetadataUrl?: string;
}

function parse<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

export class VaultOAuthProvider implements OAuthClientProvider {
  /** Set when an authorization (browser) is needed. */
  authorizationRequired = false;
  /** Interactive mode: the URL to send the person to. */
  authorizationUrl?: URL;
  /** Client ID Metadata Document URL (SEP-991), when this instance has a public https URL. */
  readonly clientMetadataUrl?: string;
  refreshError?: OAuthHttpError;
  private discoveryError?: OAuthHttpError;

  constructor(
    private readonly connector: ConnectorConfig,
    private readonly secrets: ConnectorSecrets,
    private readonly options: VaultOAuthProviderOptions,
  ) {
    if (options.clientMetadataUrl && !options.preregistered && /^https:\/\/[^/]+\/.+/.test(options.clientMetadataUrl)) {
      this.clientMetadataUrl = options.clientMetadataUrl;
    }
  }

  /** The transports use the same fetch for MCP traffic and OAuth. Leave MCP challenges to the SDK. */
  readonly fetch: typeof fetch = async (input, init) => {
    const response = await globalThis.fetch(input, init);
    if (response.status < 400) return response;
    const body = init?.body;
    let step: OAuthStep;
    if (body instanceof URLSearchParams) {
      step = body.get("grant_type") === "refresh_token" ? "refresh" : "exchange";
    } else if (typeof body === "string" && OAuthClientMetadataSchema.safeParse(parse<unknown>(body)).success) {
      step = "registration";
    } else if (!init?.method && !new Headers(init?.headers).get("accept")?.includes("text/event-stream")) {
      step = "discovery";
    } else {
      return response;
    }
    if (step === "discovery") {
      // Let the SDK probe other well-known paths. Report a rejection if no path succeeds.
      if (response.status !== 404 && response.status !== 405) {
        const error = await OAuthHttpError.fromResponse(this.connector.name, step, response.clone());
        this.discoveryError = error;
      }
      return response;
    }
    const error = await OAuthHttpError.fromResponse(this.connector.name, step, response, init);
    if (step === "refresh" && error.code === "invalid_grant") {
      // Keep the SDK's invalid-grant recovery (discard the tokens and request sign-in).
      this.refreshError = error;
      throw new InvalidGrantError(error.message);
    }
    throw error;
  };

  /** Read fresh every time: another process (a task runner) may have refreshed the tokens meanwhile. */
  private creds(): Promise<Record<string, string>> {
    return this.secrets.get(this.connector.id);
  }

  private async save(values: Record<string, string | undefined>): Promise<void> {
    await this.secrets.patch(this.connector.id, values);
  }

  /** Load the stored redirect URI (non-interactive refreshes reuse the one the tokens were issued for). */
  async init(): Promise<this> {
    const creds = await this.creds();
    if (!this.options.redirectUrl && creds[SECRET_KEYS.redirectUri]) this.options.redirectUrl = creds[SECRET_KEYS.redirectUri];
    return this;
  }

  /**
   * Forget a stored client that no longer matches this instance's public URLs: a CIMD client_id
   * (metadata document URL) other than the current one, or a dynamic registration for another
   * redirect URI. The next authorization then registers again (or uses the current CIMD URL).
   * Returns why it was dropped, if it was.
   */
  async dropStaleClient(): Promise<string | undefined> {
    if (this.options.preregistered || !this.options.redirectUrl) return undefined;
    const creds = await this.creds();
    const info = parse<{ client_id?: unknown; redirect_uris?: unknown }>(creds[SECRET_KEYS.clientInfo]);
    if (!info || typeof info.client_id !== "string") return undefined;
    const redirect = this.options.redirectUrl;
    let reason: string | undefined;
    if (/^https?:\/\//.test(info.client_id)) {
      if (info.client_id !== this.clientMetadataUrl) reason = `metadata document URL changed (was ${info.client_id})`;
    } else if (Array.isArray(info.redirect_uris)) {
      if (!info.redirect_uris.includes(redirect)) reason = `registered for another redirect URI (${info.redirect_uris.join(", ")})`;
    } else if (creds[SECRET_KEYS.redirectUri] && creds[SECRET_KEYS.redirectUri] !== redirect) {
      reason = `registered for another redirect URI (${creds[SECRET_KEYS.redirectUri]})`;
    }
    if (!reason) return undefined;
    await this.invalidateCredentials("client");
    return reason;
  }

  /** The pre-registered client in use, if any. */
  get preregisteredClient(): PreregisteredClient | undefined {
    return this.options.preregistered;
  }

  get redirectUrl(): string | undefined {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const scopes = this.connector.auth.oauth?.scopes;
    return {
      client_name: "Polpo",
      client_uri: "https://polpo.sh",
      redirect_uris: this.options.redirectUrl ? [this.options.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scopes?.length ? { scope: scopes.join(" ") } : {}),
    };
  }

  async state(): Promise<string> {
    const state = randomBytes(24).toString("base64url");
    // a tool call that finds the tokens gone must not overwrite a pending authorization's state
    if (!this.options.interactive) return state;
    await this.save({
      [SECRET_KEYS.state]: state,
      [SECRET_KEYS.stateExpires]: String(Date.now() + OAUTH_STATE_TTL_MS),
      ...(this.options.redirectUrl ? { [SECRET_KEYS.redirectUri]: this.options.redirectUrl } : {}),
    });
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const pre = this.options.preregistered;
    if (pre) return { client_id: pre.clientId, ...(pre.clientSecret ? { client_secret: pre.clientSecret } : {}) };
    return parse<OAuthClientInformationMixed>((await this.creds())[SECRET_KEYS.clientInfo]);
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    // a pre-registered client is configuration, not something to store per connector
    if (this.options.preregistered) return;
    await this.save({ [SECRET_KEYS.clientInfo]: JSON.stringify(info) });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return parse<OAuthTokens>((await this.creds())[SECRET_KEYS.tokens]);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.refreshError = undefined;
    // a refresh response may omit the refresh token: keep the one we had
    const previous = await this.tokens();
    const next = { ...tokens, ...(tokens.refresh_token ? {} : previous?.refresh_token ? { refresh_token: previous.refresh_token } : {}) };
    await this.save({ [SECRET_KEYS.tokens]: JSON.stringify({ ...next, obtained_at: Date.now() }) });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.authorizationRequired = true;
    if (!this.options.interactive) return;
    for (const [key, value] of Object.entries(this.connector.auth.oauth?.extraAuthParams ?? {})) url.searchParams.set(key, value);
    this.authorizationUrl = url;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    if (!this.options.interactive) return;
    await this.save({ [SECRET_KEYS.verifier]: verifier });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.creds())[SECRET_KEYS.verifier];
    if (!verifier) throw new Error("No pending authorization for this connector (start it again)");
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const keys: string[] = [];
    if (scope === "all" || scope === "client") keys.push(SECRET_KEYS.clientInfo);
    if (scope === "all" || scope === "tokens") keys.push(SECRET_KEYS.tokens);
    if (scope === "all" || scope === "verifier") keys.push(SECRET_KEYS.verifier);
    if (scope === "all" || scope === "discovery") keys.push(SECRET_KEYS.discovery);
    await this.save(Object.fromEntries(keys.map((k) => [k, undefined])));
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const error = this.discoveryError;
    this.discoveryError = undefined;
    if (!state.authorizationServerMetadata && error) throw error;
    await this.save({ [SECRET_KEYS.discovery]: JSON.stringify(state) });
  }

  /** The SDK throws on discovery 5xx responses before saving discovery state. */
  takeDiscoveryError(): OAuthHttpError | undefined {
    const error = this.discoveryError;
    this.discoveryError = undefined;
    return error;
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const saved = parse<OAuthDiscoveryState>((await this.creds())[SECRET_KEYS.discovery]);
    if (saved) return saved;
    // servers without protected-resource metadata (Google): the configured authorization server
    const issuer = this.connector.auth.oauth?.authorizationServer;
    return issuer ? { authorizationServerUrl: issuer } : undefined;
  }
}
