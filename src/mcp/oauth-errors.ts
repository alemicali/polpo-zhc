import { OAuthErrorResponseSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

export type OAuthStep = "discovery" | "registration" | "exchange" | "refresh";

/** The SDK propagates OAuthError subclasses during refresh, while generic errors trigger a redirect. */
export class OAuthHttpError extends OAuthError {
  constructor(
    name: string,
    readonly step: OAuthStep,
    readonly status: number,
    detail: string,
    readonly code?: string,
  ) {
    const action = {
      discovery: "could not load OAuth discovery metadata",
      registration: "did not accept the OAuth client registration",
      exchange: "did not accept the OAuth authorization code",
      refresh: "could not refresh the OAuth token",
    }[step];
    super(`${name} ${action} (${detail}).`);
  }

  static async fromResponse(name: string, step: OAuthStep, response: Response, init?: RequestInit): Promise<OAuthHttpError> {
    // Node fetch can return a native Response even when Hono replaces the global constructor.
    // Read the body directly, so error parsing does not depend on instanceof Response.
    const body = await response.text().catch(() => "");
    let oauth;
    try { oauth = OAuthErrorResponseSchema.safeParse(JSON.parse(body)); } catch { /* plain-text or HTML error */ }
    const code = oauth?.success ? oauth.data.error : undefined;
    const isHtml = /^\s*</.test(body) || /text\/html/i.test(response.headers.get("content-type") ?? "");
    let detail = body;
    if (oauth?.success) detail = oauth.data.error_description ?? "";
    else if (oauth) detail = "";
    else if (isHtml) detail = "The server returned an HTML error page";
    // Some providers echo submitted credentials in errors. Keep those out of lastError and the API.
    const [scheme, authorization] = new Headers(init?.headers).get("authorization")?.split(/\s+/, 2) ?? [];
    const secrets: Array<string | undefined> = [authorization];
    if (scheme?.toLowerCase() === "basic" && authorization) {
      const credentials = Buffer.from(authorization, "base64").toString("utf8");
      const separator = credentials.indexOf(":");
      if (separator >= 0) secrets.push(credentials.slice(separator + 1));
    }
    if (init?.body instanceof URLSearchParams) {
      for (const field of ["client_secret", "code", "code_verifier", "refresh_token"]) secrets.push(init.body.get(field) ?? undefined);
    }
    for (const secret of secrets) {
      if (secret) detail = detail.replaceAll(secret, "[redacted]").replaceAll(encodeURIComponent(secret), "[redacted]");
    }
    const summary = detail.replace(/\s+/g, " ").trim().slice(0, 250);
    const status = response.status;
    const label = code && /^[a-zA-Z0-9_.-]{1,60}$/.test(code) ? code : `HTTP ${status}`;
    return new OAuthHttpError(name, step, status, summary ? `${label}: ${summary}` : label, code);
  }
}
