import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  checkEndpoint,
  classifyAddress,
  classifyHostname,
  createGuardedFetch,
  setEndpointResolverForTests,
} from "../llm/endpoint-guard.js";

describe("classifyAddress", () => {
  it.each([
    ["8.8.8.8", "public"],
    ["1.1.1.1", "public"],
    ["127.0.0.1", "private"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.10", "private"],
    ["100.64.0.1", "private"],
    ["100.101.102.103", "private"], // Tailscale
    ["0.0.0.0", "private"],
    ["169.254.169.254", "blocked"], // cloud metadata
    ["169.254.1.1", "blocked"],
    ["100.100.100.200", "blocked"], // Alibaba metadata
    ["224.0.0.1", "blocked"],
    ["::1", "private"],
    ["fd7a:115c:a1e0::1", "private"], // Tailscale ULA
    ["fc00::1", "private"],
    ["fe80::1", "blocked"],
    ["fd00:ec2::254", "blocked"], // AWS IMDS v6
    ["::ffff:127.0.0.1", "private"],
    ["::ffff:169.254.169.254", "blocked"],
    ["::ffff:8.8.8.8", "public"],
    ["64:ff9b::a9fe:a9fe", "blocked"], // NAT64-embedded metadata
    ["2002:a9fe:a9fe::1", "blocked"], // 6to4-embedded metadata
    ["2606:4700:4700::1111", "public"],
  ])("%s → %s", (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });

  it("classifies well-known hostnames", () => {
    expect(classifyHostname("metadata.google.internal")).toBe("blocked");
    expect(classifyHostname("localhost")).toBe("private");
    expect(classifyHostname("foo.localhost")).toBe("private");
    expect(classifyHostname("[::1]")).toBe("private");
    expect(classifyHostname("api.openai.com")).toBeUndefined();
  });
});

describe("checkEndpoint", () => {
  afterEach(() => setEndpointResolverForTests(undefined));

  it("blocks hostnames resolving to private addresses unless allowed", async () => {
    setEndpointResolverForTests(async () => [{ address: "10.0.0.5", family: 4 }]);
    const blocked = await checkEndpoint("https://llm.corp.example/v1", {});
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/Allow private network/);
    const allowed = await checkEndpoint("https://llm.corp.example/v1", { allowPrivateNetwork: true });
    expect(allowed.ok).toBe(true);
    expect(allowed.addressClass).toBe("private");
  });

  it("never allows metadata, even with the private toggle", async () => {
    setEndpointResolverForTests(async () => [{ address: "169.254.169.254", family: 4 }]);
    expect((await checkEndpoint("http://evil.example/", { allowPrivateNetwork: true })).ok).toBe(false);
    expect((await checkEndpoint("http://169.254.169.254/latest", { allowPrivateNetwork: true })).ok).toBe(false);
    expect((await checkEndpoint("http://metadata.google.internal/", { allowPrivateNetwork: true })).ok).toBe(false);
  });

  it("rejects mixed answers (any private address blocks)", async () => {
    setEndpointResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    expect((await checkEndpoint("https://mixed.example/", {})).ok).toBe(false);
  });

  it("reports DNS failures as unresolved (not a policy violation)", async () => {
    setEndpointResolverForTests(async () => { throw Object.assign(new Error("nope"), { code: "ENOTFOUND" }); });
    const r = await checkEndpoint("https://does-not-exist.example/", {});
    expect(r.ok).toBe(true);
    expect(r.unresolved).toBe(true);
  });
});

describe("createGuardedFetch", () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
        res.end();
        return;
      }
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("x".repeat(5000));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, host: req.headers.host }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });
  afterEach(() => setEndpointResolverForTests(undefined));

  it("blocks loopback IP literals unless allowPrivateNetwork", async () => {
    await expect(createGuardedFetch()(`http://127.0.0.1:${port}/`)).rejects.toThrow(/private\/internal/);
    const res = await createGuardedFetch({ allowPrivateNetwork: true })(`http://127.0.0.1:${port}/`);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("DNS rebinding: the check runs on the address actually connected to", async () => {
    // First lookup (pre-flight) says public, the connect-time lookup returns loopback.
    let calls = 0;
    setEndpointResolverForTests(async () => (calls++ === 0 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]));
    const pre = await checkEndpoint(`http://rebind.example:${port}/`, {});
    expect(pre.ok).toBe(true);
    await expect(createGuardedFetch()(`http://rebind.example:${port}/`)).rejects.toThrow(/private\/internal/);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("connects to the resolved (allowed) address with the original Host header", async () => {
    setEndpointResolverForTests(async () => [{ address: "127.0.0.1", family: 4 }]);
    const res = await createGuardedFetch({ allowPrivateNetwork: true })(`http://my-llm.internal:${port}/`);
    expect(await res.json()).toEqual({ ok: true, host: `my-llm.internal:${port}` });
  });

  it("refuses redirects", async () => {
    await expect(createGuardedFetch({ allowPrivateNetwork: true })(`http://127.0.0.1:${port}/redirect`)).rejects.toThrow(/redirect/i);
  });

  it("caps response size", async () => {
    const res = await createGuardedFetch({ allowPrivateNetwork: true, maxResponseBytes: 1000 })(`http://127.0.0.1:${port}/big`);
    await expect(res.text()).rejects.toThrow();
  });

  it("honours abort signals", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(createGuardedFetch({ allowPrivateNetwork: true })(`http://127.0.0.1:${port}/`, { signal: ac.signal })).rejects.toThrow();
  });
});
