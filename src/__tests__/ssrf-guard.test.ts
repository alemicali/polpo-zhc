import { describe, it, expect } from "vitest";
import { assertUrlAllowed } from "../tools/ssrf-guard.js";

describe("assertUrlAllowed", () => {
  // ── Blocked addresses ──

  it("blocks localhost", () => {
    expect(() => assertUrlAllowed("http://localhost/api")).toThrow(/SSRF blocked/);
  });

  it("blocks 127.0.0.1", () => {
    expect(() => assertUrlAllowed("http://127.0.0.1:8080/")).toThrow(/SSRF blocked/);
  });

  it("blocks 127.x.x.x range", () => {
    expect(() => assertUrlAllowed("http://127.255.0.1/")).toThrow(/loopback/);
  });

  it("blocks [::1] (IPv6 loopback)", () => {
    expect(() => assertUrlAllowed("http://[::1]:3000/")).toThrow(/SSRF blocked/);
  });

  it("blocks 0.0.0.0", () => {
    expect(() => assertUrlAllowed("http://0.0.0.0/")).toThrow(/SSRF blocked/);
  });

  it("blocks 10.x.x.x (RFC1918)", () => {
    expect(() => assertUrlAllowed("http://10.0.0.1/")).toThrow(/private network/);
    expect(() => assertUrlAllowed("http://10.255.255.255/")).toThrow(/private network/);
  });

  it("blocks 172.16-31.x.x (RFC1918)", () => {
    expect(() => assertUrlAllowed("http://172.16.0.1/")).toThrow(/private network/);
    expect(() => assertUrlAllowed("http://172.31.255.255/")).toThrow(/private network/);
  });

  it("does not block 172.32.x.x (outside /12 range)", () => {
    expect(() => assertUrlAllowed("http://172.32.0.1/")).not.toThrow();
  });

  it("blocks 192.168.x.x (RFC1918)", () => {
    expect(() => assertUrlAllowed("http://192.168.1.1/")).toThrow(/private network/);
    expect(() => assertUrlAllowed("http://192.168.0.100/")).toThrow(/private network/);
  });

  it("blocks 169.254.169.254 (cloud metadata)", () => {
    expect(() => assertUrlAllowed("http://169.254.169.254/latest/meta-data/")).toThrow(/link-local/);
  });

  it("blocks metadata.google.internal", () => {
    expect(() => assertUrlAllowed("http://metadata.google.internal/computeMetadata/")).toThrow(/SSRF blocked/);
  });

  // ── Allowed addresses ──

  it("allows normal external URLs", () => {
    expect(() => assertUrlAllowed("https://api.example.com/v1/data")).not.toThrow();
    expect(() => assertUrlAllowed("https://github.com/user/repo")).not.toThrow();
  });

  it("allows public IPs", () => {
    expect(() => assertUrlAllowed("http://8.8.8.8/")).not.toThrow();
    expect(() => assertUrlAllowed("http://1.1.1.1/")).not.toThrow();
  });

  // ── Error handling ──

  it("throws for malformed URLs", () => {
    expect(() => assertUrlAllowed("not-a-url")).toThrow(/Invalid URL/);
    expect(() => assertUrlAllowed("")).toThrow(/Invalid URL/);
  });
});
