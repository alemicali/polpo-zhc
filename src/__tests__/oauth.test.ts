import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  authorizationServerMetadata, consentPage, isPrivateAddress, OAuthServer, pkceMatches, protectedResourceMetadata, redirectUriMatches,
} from "../server/oauth.js";

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
// host names resolve to a public address, except the ones made to look internal
const resolve = async (hostname: string) => [hostname.endsWith(".internal") ? "100.101.102.103" : "160.79.104.10"];
function server(fetchImpl?: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "polpo-oauth-"));
  dirs.push(dir);
  return { oauth: new OAuthServer(dir, fetchImpl, resolve), dir };
}
const RESOURCE = "https://polpo.example.com/mcp";
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

describe("OAuth for the MCP connector", () => {
  it("publishes discovery metadata for the resource and the authorization server", () => {
    expect(protectedResourceMetadata("https://polpo.example.com")).toMatchObject({ resource: RESOURCE, authorization_servers: ["https://polpo.example.com"] });
    expect(authorizationServerMetadata("https://polpo.example.com")).toMatchObject({
      issuer: "https://polpo.example.com",
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ["none"],
      registration_endpoint: "https://polpo.example.com/oauth/register",
    });
  });

  it("matches redirect URIs exactly, and loopback ones on any port", () => {
    expect(redirectUriMatches("https://claude.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectUriMatches("https://claude.ai/api/mcp/auth_callback", "https://evil.ai/api/mcp/auth_callback")).toBe(false);
    expect(redirectUriMatches("http://localhost/callback", "http://localhost:3118/callback")).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1/callback", "http://127.0.0.1:50211/callback")).toBe(true);
    expect(redirectUriMatches("http://localhost/callback", "http://localhost:3118/other")).toBe(false);
    expect(redirectUriMatches("http://localhost/callback", "http://127.0.0.1:3118/callback")).toBe(false);
  });

  it("verifies S256 PKCE", () => {
    const { verifier, challenge } = pkce();
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches(pkce().verifier, challenge)).toBe(false);
    expect(pkceMatches("short", challenge)).toBe(false);
  });

  it("DCR → authorize → code (single use, PKCE) → tokens → refresh rotates → revoke", async () => {
    const { oauth, dir } = server();
    expect(() => oauth.register({ redirect_uris: ["http://evil.example.com/cb"] })).toThrow(/https, or http on a loopback/);
    const client = oauth.register({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    const { verifier, challenge } = pkce();
    const req = { response_type: "code", client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: RESOURCE };

    await expect(oauth.checkAuthorizeRequest({ ...req, redirect_uri: "https://evil.ai/cb" }, RESOURCE)).rejects.toThrow(/not registered/);
    await expect(oauth.checkAuthorizeRequest({ ...req, code_challenge_method: "plain" }, RESOURCE)).rejects.toThrow(/S256/);
    await expect(oauth.checkAuthorizeRequest({ ...req, resource: "https://other.example.com/mcp" }, RESOURCE)).rejects.toThrow(/Unknown resource/);
    expect((await oauth.checkAuthorizeRequest(req, RESOURCE)).client_name).toBe("Claude");

    const code = oauth.issueCode(req, RESOURCE, "ada@example.com");
    expect(() => oauth.exchange({ grant_type: "authorization_code", code, redirect_uri: req.redirect_uri, code_verifier: pkce().verifier })).toThrow(/PKCE/);
    // the code was used by the failed attempt: it does not work again
    expect(() => oauth.exchange({ grant_type: "authorization_code", code, redirect_uri: req.redirect_uri, code_verifier: verifier })).toThrow(/invalid or expired/);

    const code2 = oauth.issueCode(req, RESOURCE, "ada@example.com");
    const tokens = oauth.exchange({ grant_type: "authorization_code", code: code2, redirect_uri: req.redirect_uri, code_verifier: verifier, client_id: client.client_id });
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "polpo" });
    expect(oauth.verifyAccessToken(tokens.access_token, RESOURCE)).toEqual({ subject: "ada@example.com", client_id: client.client_id });
    expect(oauth.verifyAccessToken(tokens.access_token, "https://other.example.com/mcp")).toBeNull();
    // only hashes are stored
    expect(readFileSync(join(dir, "oauth.json"), "utf-8")).not.toContain(tokens.access_token);

    const refreshed = oauth.exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    expect(() => oauth.exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).toThrow(/invalid or expired/);

    oauth.revoke(refreshed.access_token);
    expect(oauth.verifyAccessToken(refreshed.access_token, RESOURCE)).toBeNull();
    expect(() => oauth.exchange({ grant_type: "refresh_token", refresh_token: refreshed.refresh_token })).toThrow(/invalid or expired/);
  });

  it("reads a Client ID Metadata Document (Claude Code)", async () => {
    const id = "https://claude.ai/oauth/claude-code-client-metadata";
    const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(
      url === id ? { client_id: id, client_name: "Claude Code", redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"] } : {},
    ))) as unknown as typeof fetch;
    const { oauth } = server(fetchImpl);
    const { challenge } = pkce();
    const client = await oauth.checkAuthorizeRequest({
      response_type: "code", client_id: id, redirect_uri: "http://localhost:54321/callback", code_challenge: challenge, code_challenge_method: "S256",
    }, RESOURCE);
    expect(client).toMatchObject({ client_name: "Claude Code", source: "cimd" });
    await expect(oauth.client("https://claude.ai/other")).rejects.toThrow(/client_id does not match/);
    await expect(oauth.client("http://plain.example.com/meta")).rejects.toThrow(/Unknown client/);
  });

  it("never fetches a metadata document from an address inside the network", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const { oauth } = server(fetchImpl);
    for (const id of ["https://127.0.0.1/meta", "https://[::1]/meta", "https://192.168.1.4/meta", "https://box.internal/meta"]) {
      await expect(oauth.client(id)).rejects.toThrow(/Could not read/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(["10.0.0.1", "172.20.1.1", "100.64.0.1", "169.254.169.254", "::ffff:127.0.0.1", "fd7a:115c:a1e0::1", "fe80::1"].every(isPrivateAddress)).toBe(true);
    expect(["160.79.104.10", "8.8.8.8", "2606:4700::1111"].some(isPrivateAddress)).toBe(false);
  });

  it("keeps open registration bounded, without dropping clients that hold tokens", () => {
    const { oauth } = server();
    const first = oauth.register({ redirect_uris: ["https://a.example.com/cb"] });
    const { verifier, challenge } = pkce();
    const req = { client_id: first.client_id, redirect_uri: "https://a.example.com/cb", code_challenge: challenge };
    oauth.exchange({ grant_type: "authorization_code", code: oauth.issueCode(req, RESOURCE, "x"), redirect_uri: req.redirect_uri, code_verifier: verifier });
    const second = oauth.register({ redirect_uris: ["https://b.example.com/cb"] });
    for (let i = 0; i < 205; i++) oauth.register({ redirect_uris: ["https://spam.example.com/cb"] });
    return Promise.all([
      expect(oauth.client(first.client_id)).resolves.toMatchObject({ client_id: first.client_id }),
      expect(oauth.client(second.client_id)).rejects.toThrow(/Unknown client/),
    ]);
  });

  it("the consent page names the app and where it goes back, and warns for local apps", () => {
    const html = consentPage({
      client: { client_id: "c", client_name: "Claude <b>", redirect_uris: [], source: "dcr", created_at: "" },
      redirectUri: "http://localhost:3118/callback", params: { client_id: "c", state: "s\"x" }, method: "api-key",
    });
    expect(html).toContain("Connect Claude &#60;b&#62; to Polpo");
    expect(html).toContain("<b>localhost:3118</b>");
    expect(html).toMatch(/app on your computer/);
    expect(html).toContain('name="api_key"');
    expect(html).toContain('value="s&#34;x"');
  });
});
