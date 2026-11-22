/**
 * ui/server.mjs inlines the instance's default look into /runtime-config.js (read from the API's
 * public /api/v1/config/appearance, cached briefly), so index.html's inline script paints it on the
 * first frame; an API that is down or older leaves it out (the page uses its cached copy).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const SERVER = fileURLToPath(new URL("../../ui/server.mjs", import.meta.url));
let root: string;
let api: Server;
let apiHits = 0;
let appearance: unknown = { theme: "light", palette: "claude", custom: { enabled: true, light: { primary: "#c96442" } } };
let branding: unknown = { productName: "Acme Ops", tagline: "Internal AI", logoUrl: "/api/v1/config/branding/logo", logoFrame: "none", secret: "never inlined" };
let brandingHits = 0;
let orchestrator: unknown = { name: "Ada" };
const uis: ChildProcess[] = [];

async function startUi(env: Record<string, string>): Promise<string> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, [SERVER, "--root", root, "--port", String(port), "--host", "127.0.0.1"], {
    env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  uis.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the UI server did not start")), 10_000);
    child.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("listening")) { clearTimeout(timer); resolve(); } });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`the UI server exited (${code})`)); });
  });
  return `http://127.0.0.1:${port}`;
}

const runtimeConfig = async (base: string) => {
  const text = await (await fetch(`${base}/runtime-config.js`)).text();
  const sandbox: { __POLPO_RUNTIME_CONFIG__?: Record<string, unknown> } = {};
  new Function("globalThis", text)(sandbox);
  return { text, config: sandbox.__POLPO_RUNTIME_CONFIG__! };
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "polpo-ui-root-"));
  await writeFile(join(root, "index.html"), '<!doctype html><meta name="apple-mobile-web-app-title" content="Polpo ZHC" /><title>Polpo ZHC — AI Factory</title>');
  api = createServer((req, res) => {
    if (req.url === "/api/v1/config/appearance") {
      apiHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: appearance }));
      return;
    }
    if (req.url === "/api/v1/config/orchestrator") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: orchestrator }));
      return;
    }
    if (req.url === "/api/v1/config/branding") {
      brandingHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: branding }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
});

afterAll(async () => {
  for (const child of uis) child.kill();
  await new Promise<void>((r) => api.close(() => r()));
  await rm(root, { recursive: true, force: true });
});

describe("runtime-config.js", () => {
  it("carries the instance appearance, cached for a while", async () => {
    const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    const base = await startUi({ POLPO_API_URL: apiUrl, POLPO_APPEARANCE_TTL_MS: "60000" });
    const { config } = await runtimeConfig(base);
    expect(config).toMatchObject({ baseUrl: apiUrl, appearance });
    const hits = apiHits;
    appearance = { theme: "dark" };
    expect((await runtimeConfig(base)).config.appearance).toMatchObject({ theme: "light" }); // still cached
    expect(apiHits).toBe(hits);
  });

  it("asks again once the cache is old, and never lets a value close the script", async () => {
    const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    appearance = { theme: "dark", custom: { enabled: true, light: { fontFamily: "</script><script>alert(1)</script>" } } };
    const base = await startUi({ POLPO_API_URL: apiUrl, POLPO_APPEARANCE_TTL_MS: "0" });
    const { text, config } = await runtimeConfig(base);
    expect(text).not.toContain("</script>");
    expect(config.appearance).toEqual(appearance);
  });

  it("carries the instance branding (display fields only), cached like the look", async () => {
    const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    const base = await startUi({ POLPO_API_URL: apiUrl, POLPO_APPEARANCE_TTL_MS: "60000" });
    const { config } = await runtimeConfig(base);
    expect(config.branding).toEqual({ productName: "Acme Ops", tagline: "Internal AI", logoUrl: "/api/v1/config/branding/logo", logoFrame: "none" });
    const hits = brandingHits;
    branding = { productName: "Changed" };
    expect((await runtimeConfig(base)).config.branding).toMatchObject({ productName: "Acme Ops" }); // still cached
    expect(brandingHits).toBe(hits);
  });

  it("reads the branding next to POLPO_APPEARANCE_URL, and never lets a name close the script", async () => {
    const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    branding = { productName: "</script><script>alert(1)</script>", logoFrame: "circle" };
    const base = await startUi({ POLPO_API_URL: "", POLPO_APPEARANCE_URL: `${apiUrl}/api/v1/config/appearance`, POLPO_APPEARANCE_TTL_MS: "0" });
    const { text, config } = await runtimeConfig(base);
    expect(text).not.toContain("</script>");
    expect(config.branding).toEqual({ productName: "</script><script>alert(1)</script>" }); // an unknown frame is dropped
  });

  it("puts the product name in index.html's <title> (escaped), on every route; unbranded: the file as is", async () => {
    const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    branding = { productName: "Acme <Ops> & Co" };
    const base = await startUi({ POLPO_API_URL: apiUrl, POLPO_APPEARANCE_TTL_MS: "0" });
    for (const path of ["/", "/chat", "/index.html"]) {
      const html = await (await fetch(`${base}${path}`)).text();
      expect(html, path).toContain("<title>Acme &#60;Ops&#62; &#38; Co</title>");
      expect(html, path).toContain('content="Acme &#60;Ops&#62; &#38; Co"');
    }
    const first = await fetch(`${base}/`);
    const etag = first.headers.get("etag")!;
    expect((await fetch(`${base}/`, { headers: { "if-none-match": etag } })).status).toBe(304);
    branding = {};
    const plain = await (await fetch(`${base}/`)).text();
    expect(plain).toContain("<title>Polpo ZHC — AI Factory</title>");
  });

  it("carries the orchestrator's display name, separate from the branding; an invalid one is left out", async () => {
    const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    const base = await startUi({ POLPO_API_URL: apiUrl, POLPO_APPEARANCE_TTL_MS: "0" });
    expect((await runtimeConfig(base)).config.orchestratorName).toBe("Ada");
    orchestrator = { name: "x".repeat(41) };
    expect("orchestratorName" in (await runtimeConfig(base)).config).toBe(false);
    orchestrator = { name: "Ada" };
  });

  it("leaves it out when the API cannot be reached", async () => {
    const base = await startUi({ POLPO_API_URL: "http://127.0.0.1:9", POLPO_APPEARANCE_TTL_MS: "0" });
    const { config } = await runtimeConfig(base);
    expect(config.baseUrl).toBe("http://127.0.0.1:9");
    expect("appearance" in config).toBe(false);
    expect("branding" in config).toBe(false);
    expect("orchestratorName" in config).toBe(false);
    expect(await (await fetch(`${base}/`)).text()).toContain("<title>Polpo ZHC — AI Factory</title>");
  });
});
