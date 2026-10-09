import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_NAMES, describeVaultRef, isVaultRef, normalizeVaultRef, pickCredential, resolveVaultRef,
} from "@polpo-ai/core/vault-ref";
import type { VaultEntry, VaultStore } from "@polpo-ai/core";

describe("vault references", () => {
  it("accepts owner + service, trims them, and refuses system \"$\" owners", () => {
    expect(normalizeVaultRef({ owner: " alice ", service: " daytona " })).toEqual({ owner: "alice", service: "daytona" });
    expect(isVaultRef({ owner: "$sandbox", service: "sandbox-provider:e2b" })).toBe(false);
    expect(normalizeVaultRef({ owner: " $storage", service: "x" })).toBeUndefined();
    expect(normalizeVaultRef({ owner: "alice" })).toBeUndefined();
    expect(normalizeVaultRef({ owner: "", service: "x" })).toBeUndefined();
    expect(normalizeVaultRef("alice/daytona")).toBeUndefined();
    expect(normalizeVaultRef(null)).toBeUndefined();
    expect(describeVaultRef({ owner: "alice", service: "daytona" })).toBe("alice / daytona");
    expect(describeVaultRef(undefined)).toBe("not set");
  });

  it("picks a credential by any common name, casing or separator", () => {
    expect(pickCredential({ API_KEY: "k1" }, [...CREDENTIAL_NAMES.apiKey])).toBe("k1");
    expect(pickCredential({ token: " t1 " }, [...CREDENTIAL_NAMES.apiKey])).toBe("t1");
    expect(pickCredential({ "api-token": "t2" }, [...CREDENTIAL_NAMES.apiToken])).toBe("t2");
    expect(pickCredential({ AWS_ACCESS_KEY_ID: "ak" }, [...CREDENTIAL_NAMES.accessKeyId])).toBe("ak");
    expect(pickCredential({ user: "u" }, [...CREDENTIAL_NAMES.accessKeyId])).toBe("u");
    expect(pickCredential({ Secret_Access_Key: "sk" }, [...CREDENTIAL_NAMES.secretAccessKey])).toBe("sk");
    expect(pickCredential({ password: "p" }, [...CREDENTIAL_NAMES.secretAccessKey])).toBe("p");
    expect(pickCredential({ aws_session_token: "st" }, [...CREDENTIAL_NAMES.sessionToken])).toBe("st");
    // the first name in the list wins over later aliases; empty values are skipped
    expect(pickCredential({ token: "generic", apiKey: "specific" }, [...CREDENTIAL_NAMES.apiKey])).toBe("specific");
    expect(pickCredential({ apiKey: "  ", key: "k" }, [...CREDENTIAL_NAMES.apiKey])).toBe("k");
    expect(pickCredential({ other: "x" }, [...CREDENTIAL_NAMES.apiKey])).toBeUndefined();
    expect(pickCredential(undefined, [...CREDENTIAL_NAMES.apiKey])).toBeUndefined();
  });

  it("resolves the referenced entry's credentials, never a system owner's", async () => {
    const data = new Map<string, VaultEntry>([
      ["alice/e2b", { type: "api_key", credentials: { apiKey: "e2b-key" } }],
      ["$sandbox/sandbox-provider:e2b", { type: "api_key", credentials: { apiKey: "old" } }],
    ]);
    const store = { get: async (o: string, s: string) => data.get(`${o}/${s}`) } as unknown as VaultStore;
    expect(await resolveVaultRef(store, { owner: "alice", service: "e2b" })).toEqual({ apiKey: "e2b-key" });
    expect(await resolveVaultRef(store, { owner: "alice", service: "missing" })).toBeUndefined();
    expect(await resolveVaultRef(store, { owner: "$sandbox", service: "sandbox-provider:e2b" })).toBeUndefined();
    expect(await resolveVaultRef(undefined, { owner: "alice", service: "e2b" })).toBeUndefined();
    const failing = { get: async () => { throw new Error("db down"); } } as unknown as VaultStore;
    expect(await resolveVaultRef(failing, { owner: "alice", service: "e2b" })).toBeUndefined();
  });
});
