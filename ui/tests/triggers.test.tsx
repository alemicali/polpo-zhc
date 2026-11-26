import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Trigger, TriggerDelivery } from "@polpo-ai/react";

// ── SDK mock: an in-memory set of triggers behind useTriggers / useTriggerDeliveries / usePolpo ──
const state = vi.hoisted(() => ({
  triggers: [] as Trigger[],
  deliveries: [] as TriggerDelivery[],
  calls: [] as Array<{ fn: string; args: unknown[] }>,
  listeners: new Set<() => void>(),
  bump() { state.listeners.forEach((l) => l()); },
}));

vi.mock("@polpo-ai/react", async () => {
  const React = await import("react");
  const useVersion = () => {
    const [, set] = React.useState(0);
    React.useEffect(() => { const l = () => set((v) => v + 1); state.listeners.add(l); return () => { state.listeners.delete(l); }; }, []);
  };
  const record = <T,>(fn: string, value: T) => (...args: unknown[]) => { state.calls.push({ fn, args }); return Promise.resolve(typeof value === "function" ? (value as (...a: unknown[]) => unknown)(...args) : value); };
  const client = {
    rotateTriggerSecret: record("rotateTriggerSecret", (id: string) => ({ secret: "pts_rotated_secret_value", trigger: state.triggers.find((t) => t.id === id) })),
    setTriggerHmacSecret: record("setTriggerHmacSecret", () => ({ status: { secretSet: true } })),
    removeTriggerHmacSecret: record("removeTriggerHmacSecret", { secretSet: false }),
    getTriggerContractVersions: record("getTriggerContractVersions", [
      { version: 2, contract: { contentTypes: ["json"], maxBodyBytes: 262144, schema: { type: "object", required: ["email"] } }, createdAt: "2026-11-26T10:00:00Z", note: "email required" },
      { version: 1, contract: { contentTypes: ["json"], maxBodyBytes: 262144 }, createdAt: "2026-11-25T10:00:00Z", note: "Created" },
    ]),
    diffTriggerContract: record("diffTriggerContract", { from: 1, to: 2, diff: "--- v1\n+++ v2\n+  \"schema\": {}" }),
    inferTriggerSchema: record("inferTriggerSchema", { schema: { type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"] } }),
    validateTriggerSample: record("validateTriggerSample", { status: "rejected", reasons: ["The body does not match the contract (v2): 1 error"], errors: ["body.email: required"], filterMatched: false, contractVersion: 2 }),
    getTriggerDelivery: record("getTriggerDelivery", (_t: string, id: string) => state.deliveries.find((d) => d.id === id)),
    replayTriggerDelivery: record("replayTriggerDelivery", { status: "accepted", reasons: [], errors: [], filterMatched: true, mapped: { email: "ada@example.com" }, contractVersion: 2, replayOf: "tdl_1" }),
    sendTriggerTest: record("sendTriggerTest", () => state.deliveries[0]),
    getConfig: record("getConfig", { settings: { notifications: { channels: { telegram: { type: "telegram" }, ops: { type: "slack" } } } } }),
    getTriggerActionUsage: record("getTriggerActionUsage", { day: "2026-11-26", actions: 3, agentUsd: 0.25 }),
    previewTriggerActions: record("previewTriggerActions", (_id: string, o: { actions?: Array<{ id?: string; kind: string }> }) => ({
      deliveryId: "tdl_1",
      actions: (o.actions ?? []).map((a, i) => ({ actionId: a.id ?? `new${i}`, kind: a.kind, rendered: a.kind === "playbook" ? { playbook: "onboarding", params: { email: "ada@example.com" } } : { body: "New ada@example.com" } })),
    })),
    rerunTriggerActions: record("rerunTriggerActions", (_id: string, deliveryId: string) => ({ deliveryId, actionsStatus: "queued", actions: [] })),
  };
  return {
    useTriggerDelivery: (id: string | undefined, deliveryId: string | undefined) => {
      useVersion();
      const delivery = state.deliveries.find((d) => d.triggerId === id && d.id === deliveryId);
      return {
        delivery, isLoading: false, error: null, refetch: async () => {},
        rerunActions: async () => { state.calls.push({ fn: "rerunActions", args: [id, deliveryId] }); return { deliveryId, actions: [] }; },
      };
    },
    usePlaybooks: () => ({ playbooks: [{ name: "onboarding", description: "Onboard", parameters: [{ name: "email", description: "Who" }, { name: "plan", description: "Plan" }], path: "/p" }] }),
    useMissions: () => ({ missions: [{ id: "m-welcome", name: "welcome", status: "draft" }] }),
    useAgents: () => ({ agents: [{ name: "writer" }, { name: "dev" }] }),
    usePolpo: () => ({ client }),
    useEvents: () => ({ events: [] }),
    useTriggers: () => {
      useVersion();
      return {
        triggers: state.triggers, isLoading: false, error: null, refetch: async () => {},
        createTrigger: async (input: { name: string }) => {
          state.calls.push({ fn: "createTrigger", args: [input] });
          const t = { ...state.triggers[0]!, id: "new-form-00000001", name: input.name, stats: { counts: { accepted: 0, rejected: 0, filtered: 0, duplicate: 0, rate_limited: 0 }, total: 0 } };
          state.triggers = [...state.triggers, t];
          state.bump();
          return { trigger: t, secret: "pts_first_secret_value" };
        },
        updateTrigger: async (id: string, input: unknown) => {
          state.calls.push({ fn: "updateTrigger", args: [id, input] });
          return { trigger: state.triggers.find((t) => t.id === id) };
        },
        deleteTrigger: async (id: string) => { state.calls.push({ fn: "deleteTrigger", args: [id] }); },
      };
    },
    useTriggerDeliveries: (id: string | undefined, o: { status?: string[] } = {}) => {
      useVersion();
      state.calls.push({ fn: "useTriggerDeliveries", args: [id, o.status ?? []] });
      const all = state.deliveries.filter((d) => d.triggerId === id);
      const counts = { accepted: 0, rejected: 0, filtered: 0, duplicate: 0, rate_limited: 0 } as Record<string, number>;
      for (const d of all) counts[d.status]!++;
      const deliveries = all.filter((d) => !o.status?.length || o.status.includes(d.status));
      return { page: { deliveries, total: all.length, counts }, isLoading: false, error: null, refetch: async () => {} };
    },
  };
});

import { MemoryRouter } from "react-router-dom";
import { TriggersPage } from "../src/pages/triggers";

const trigger = (extra: Partial<Trigger> = {}): Trigger => ({
  id: "tally-signup-3f9a1c2e", name: "Tally signup", enabled: true, owner: "ada@example.com", createdAt: "2026-11-25T10:00:00Z", updatedAt: "2026-11-26T10:00:00Z",
  auth: { secret: true, hmac: { header: "tally-signature", algorithm: "sha256", encoding: "base64" } },
  secrets: [{ id: "sec_1", hint: "pts_Ab12…", createdAt: "2026-11-25T10:00:00Z" }], hmacSecret: { secretSet: false },
  contract: { contentTypes: ["json"], maxBodyBytes: 262144, schema: { type: "object", required: ["email"] } }, contractVersion: 2,
  rateLimitPerMinute: 60, retention: 500, mapping: { email: "{{body.email}}" },
  endpoint: "https://host.ts.net/lumea/hooks/tally-signup-3f9a1c2e", path: "/hooks/tally-signup-3f9a1c2e",
  stats: { counts: { accepted: 1, rejected: 1, filtered: 0, duplicate: 0, rate_limited: 0 }, total: 2, lastDeliveryAt: new Date(Date.now() - 120_000).toISOString(), lastStatus: "rejected" },
  ...extra,
});
const delivery = (id: string, extra: Partial<TriggerDelivery>): TriggerDelivery => ({
  id, triggerId: "tally-signup-3f9a1c2e", receivedAt: "2026-11-26T10:00:00Z", status: "accepted", httpStatus: 202, reasons: [], bytes: 40, contractVersion: 2,
  headers: { "content-type": "application/json", authorization: "[redacted]" }, query: {}, ...extra,
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.triggers = [trigger()];
  state.deliveries = [
    delivery("tdl_1", { body: { email: "ada@example.com" }, mapped: { email: "ada@example.com" } }),
    delivery("tdl_2", { status: "rejected", httpStatus: 400, reasons: ["The body does not match the contract (v2): 1 error"], errors: ["body.email: required"], body: {} }),
  ];
  state.calls = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const buttons = (text: string | RegExp) => [...document.querySelectorAll("button")].filter((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? "")));
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const tab = async (name: string) => {
  const t = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent?.trim() === name)!;
  await act(async () => { t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); });
  await flush();
};
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const render = async (path = "/triggers") => {
  await act(async () => root.render(<MemoryRouter initialEntries={[path]}><TriggersPage /></MemoryRouter>));
  await flush();
};

test("the list: endpoint, auth, a missing HMAC secret, counts and the last delivery; New trigger shows the secret once", async () => {
  await render();
  const row = $('[data-trigger="tally-signup-3f9a1c2e"]')!;
  expect(row.textContent).toContain("Tally signup");
  expect(row.textContent).toContain("https://host.ts.net/lumea/hooks/tally-signup-3f9a1c2e");
  expect(row.textContent).toContain("secret + HMAC sha256");
  expect(row.textContent).toContain("HMAC secret not set");
  expect(row.querySelector('[data-testid="row-counts"]')!.textContent).toBe("1 accepted · 1 rejected");
  expect(row.textContent).toMatch(/2 min ago/);
  expect(row.querySelector('[data-status="rejected"]')).toBeTruthy();

  await click(buttons(/New trigger/)[0]!);
  await type($<HTMLInputElement>('[data-testid="create-trigger"] input[aria-label="Name"]')!, "New form");
  await click(buttons("Create")[0]!);
  expect(state.calls.find((c) => c.fn === "createTrigger")!.args[0]).toMatchObject({ name: "New form", contract: { contentTypes: ["json"] } });
  expect($('[data-testid="secret-dialog"]')!.textContent).toContain("shown only now");
  expect($('[data-testid="secret-value"]')!.textContent).toBe("pts_first_secret_value");
  await click(buttons("I copied it")[0]!);
  expect($('[data-testid="secret-value"]')).toBeNull();
});

test("a trigger's sheet: endpoint and curl, rotation reveals the new secret once, contract with JSON / YAML, inference, validation and a versions diff", async () => {
  await render("/triggers?trigger=tally-signup-3f9a1c2e");
  const sheet = $('[data-testid="trigger-sheet"]')!;
  expect(sheet.querySelector('[data-testid="copy-endpoint"]')!.textContent).toBe("https://host.ts.net/lumea/hooks/tally-signup-3f9a1c2e");
  const curl = sheet.querySelector('[data-testid="copy-curl"]')!.textContent!;
  expect(curl).toContain("Authorization: Bearer <secret>");
  expect(curl).toContain("tally-signature: <sha256 base64 HMAC of the body>");
  expect(sheet.textContent).toMatch(/Tailscale Funnel the path \/<instance>\/hooks\//);

  await tab("Auth");
  expect($('[data-testid="secret-hints"]')!.textContent).toContain("pts_Ab12…");
  expect(document.body.textContent).toContain("not set — every delivery is refused");
  await click(buttons("Rotate")[0]!);
  expect(state.calls.find((c) => c.fn === "rotateTriggerSecret")!.args).toEqual(["tally-signup-3f9a1c2e", 86400]);
  expect($('[data-testid="secret-value"]')!.textContent).toBe("pts_rotated_secret_value");
  await click(buttons("I copied it")[0]!);
  const hmacInput = $<HTMLInputElement>('input[data-setup-field="hmac"]')!;
  expect(hmacInput.type).toBe("password");
  await type(hmacInput, "tally-signing-secret");
  await click(hmacInput.form!.querySelector('button[type="submit"]')!);
  expect(state.calls.find((c) => c.fn === "setTriggerHmacSecret")!.args).toEqual(["tally-signup-3f9a1c2e", { secret: "tally-signing-secret", overlapSeconds: 86400 }]);

  await tab("Contract");
  const schema = $<HTMLTextAreaElement>('textarea[aria-label="JSON Schema"]')!;
  expect(JSON.parse(schema.value)).toEqual({ type: "object", required: ["email"] });
  await click(buttons("YAML")[0]!);
  expect($('[data-testid="schema-yaml"]')!.textContent).toBe("type: object\nrequired:\n  - email");
  await click(buttons("JSON")[0]!);
  await type($<HTMLTextAreaElement>('textarea[aria-label="Sample body"]')!, '{"email":"a@b.co"}');
  await click(buttons(/Infer schema/)[0]!);
  expect(JSON.parse($<HTMLTextAreaElement>('textarea[aria-label="JSON Schema"]')!.value).properties.email).toEqual({ type: "string", format: "email" });
  await click(buttons(/Validate sample/)[0]!);
  expect($('[data-testid="dry-run-errors"]')!.textContent).toContain("body.email: required");
  expect($('[data-testid="contract-versions"]')!.textContent).toContain("email required");
  await click(buttons(/Diff/)[0]!);
  expect(state.calls.find((c) => c.fn === "diffTriggerContract")!.args).toEqual(["tally-signup-3f9a1c2e", 1, 2]);
  expect($('[data-testid="contract-diff"]')!.querySelector(".text-success")!.textContent).toContain("schema");
});

test("deliveries: filter by status, a delivery's payload and mapped values, replay as a dry run, send a test", async () => {
  await render("/triggers?trigger=tally-signup-3f9a1c2e");
  await tab("Deliveries");
  const list = $('[data-testid="delivery-list"]')!;
  expect(list.querySelectorAll("[data-delivery]")).toHaveLength(2);
  await click(document.querySelector('button[data-filter="rejected"]')!);
  expect(state.calls.filter((c) => c.fn === "useTriggerDeliveries").at(-1)!.args).toEqual(["tally-signup-3f9a1c2e", ["rejected"]]);
  expect($('[data-testid="delivery-list"]')!.querySelectorAll("[data-delivery]")).toHaveLength(1);
  await click(document.querySelector('button[data-filter="rejected"]')!);
  await click(document.querySelector('[data-delivery="tdl_1"]')!);
  const dialog = $('[data-testid="delivery-dialog"]')!;
  expect(dialog.textContent).toContain("Mapped values");
  expect(dialog.textContent).toContain("ada@example.com");
  expect(dialog.textContent).toContain("[redacted]");
  await click(buttons(/Replay through the current contract/)[0]!);
  expect($('[data-testid="dry-run"]')!.textContent).toContain("Accepted");
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await flush();
  await click(buttons(/Send test/)[0]!);
  expect(state.calls.find((c) => c.fn === "sendTriggerTest")!.args).toEqual(["tally-signup-3f9a1c2e", { body: { hello: "world" }, contentType: "json" }]);
});

test("rules: filter, dedupe and mapping are saved together; the mapping preview runs a dry run with the draft", async () => {
  await render("/triggers?trigger=tally-signup-3f9a1c2e");
  await tab("Rules");
  await click(buttons(/Add condition/)[0]!);
  await type($<HTMLInputElement>('input[aria-label="Condition 1 path"]')!, "body.event");
  await type($<HTMLInputElement>('input[aria-label="Condition 1 value"]')!, "submitted");
  await type($<HTMLInputElement>('input[placeholder="{{body.submission_id}}"]')!, "{{body.submission_id}}");
  expect($<HTMLInputElement>('input[aria-label="Field 1 template"]')!.value).toBe("{{body.email}}");
  await type($<HTMLTextAreaElement>('textarea[aria-label="Preview sample"]')!, '{"email":"x@y.z"}');
  await click(buttons(/Preview/)[0]!);
  expect(state.calls.find((c) => c.fn === "validateTriggerSample")!.args[2]).toMatchObject({ mapping: { email: "{{body.email}}" }, filter: { conditions: [{ path: "body.event", op: "equals", value: "submitted" }] } });
  await click(buttons("Save rules")[0]!);
  expect(state.calls.find((c) => c.fn === "updateTrigger")!.args[1]).toEqual({
    filter: { mode: "all", conditions: [{ path: "body.event", op: "equals", value: "submitted" }] },
    mapping: { email: "{{body.email}}" }, dedupe: { key: "{{body.submission_id}}", ttlSeconds: 86400 }, rateLimitPerMinute: 60, retention: 500,
  });
});

test("an assistant's setup link opens the trigger on Auth with the HMAC secret field", async () => {
  await render("/triggers?trigger=tally-signup-3f9a1c2e&focus=hmac&setup=trigger:tally-signup-3f9a1c2e:hmac");
  expect([...document.querySelectorAll('[role="tab"]')].find((x) => x.getAttribute("aria-selected") === "true")!.textContent).toBe("Auth");
  expect($('input[data-setup-field="hmac"]')).toBeTruthy();
});

test("actions: add a playbook (parameters prefilled from the mapping) and a notification, reorder, disable, a live preview, limits; saved together", async () => {
  await render("/triggers?trigger=tally-signup-3f9a1c2e");
  await tab("Actions");
  expect($('[data-testid="no-actions"]')!.textContent).toContain("only recorded");
  expect($('[data-testid="action-usage"]')!.textContent).toContain("3 actions started · agents spent $0.25");
  await click(buttons(/Add action/)[0]!);
  const pick = $<HTMLSelectElement>('select[aria-label="Playbook"]')!;
  await act(async () => { pick.value = "onboarding"; pick.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
  expect($<HTMLInputElement>('input[aria-label="Parameters 1 template"]')!.value).toBe("{{mapped.email}}");
  expect($<HTMLInputElement>('input[aria-label="Parameters 2 name"]')!.value).toBe("plan");
  await click(document.querySelector('button[aria-label="Remove parameters 2"]')!);
  const kind = $<HTMLSelectElement>('select[aria-label="Action kind"]')!;
  await act(async () => { kind.value = "notify"; kind.dispatchEvent(new Event("change", { bubbles: true })); });
  await click(buttons(/Add action/)[0]!);
  const channel = $<HTMLSelectElement>('select[aria-label="Channel"]')!;
  expect([...channel.options].map((o) => o.value)).toEqual(["", "telegram", "ops"]);
  await act(async () => { channel.value = "telegram"; channel.dispatchEvent(new Event("change", { bubbles: true })); });
  await type($<HTMLTextAreaElement>('textarea[aria-label="Notification message"]')!, "New {{mapped.email}}");
  // the notification first, then disabled
  await click(document.querySelector('button[aria-label="Move action 2 up"]')!);
  expect([...document.querySelectorAll("[data-kind]")].map((x) => x.getAttribute("data-kind"))).toEqual(["notify", "playbook"]);
  await click(document.querySelector('button[aria-label="Action 2 enabled"]')!);
  await type($<HTMLInputElement>('input[aria-label="Actions per minute"]')!, "10");
  await act(async () => { await new Promise((r) => setTimeout(r, 650)); });
  await flush();
  expect($('[data-testid="actions-preview"]')!.textContent).toContain("New ada@example.com");
  expect(state.calls.filter((c) => c.fn === "previewTriggerActions").at(-1)!.args[0]).toBe("tally-signup-3f9a1c2e");
  await click(buttons("Save actions")[0]!);
  expect(state.calls.find((c) => c.fn === "updateTrigger")!.args[1]).toEqual({
    actions: [
      { kind: "notify", enabled: true, channel: "telegram", body: "New {{mapped.email}}" },
      { kind: "playbook", enabled: false, playbook: "onboarding", params: { email: "{{mapped.email}}" } },
    ],
    actionLimits: { perMinute: 10 },
  });
});

test("an agent action: Polpo or an agent, the data it gets, a tool restriction, the reply to a Telegram chat", async () => {
  state.triggers = [trigger({ actions: [{ id: "ag", kind: "agent", enabled: true, agent: "writer", instructions: "Uppercase every field", allowedTools: [], deliverTo: { channel: "telegram", chatId: "42" } }] })];
  await render("/triggers?trigger=tally-signup-3f9a1c2e");
  expect([...document.querySelectorAll('[role="tab"]')].map((x) => x.textContent)).toContain("Actions 1");
  await tab("Actions 1");
  expect($<HTMLSelectElement>('select[aria-label="Agent"]')!.value).toBe("writer");
  expect($<HTMLInputElement>('input[aria-label="Allowed tools"]')!.value).toBe("");
  expect($<HTMLInputElement>('input[aria-label="Reply chat id"]')!.value).toBe("42");
  expect(document.body.textContent).toContain("never as instructions");
  await type($<HTMLInputElement>('input[aria-label="Allowed tools"]')!, "read_file, mcp__x__*");
  await click(buttons("Save actions")[0]!);
  expect(state.calls.find((c) => c.fn === "updateTrigger")!.args[1]).toEqual({
    actions: [{ id: "ag", kind: "agent", enabled: true, agent: "writer", instructions: "Uppercase every field", allowedTools: ["read_file", "mcp__x__*"], deliverTo: { channel: "telegram", chatId: "42" } }],
    actionLimits: null,
  });
});

test("a delivery's action runs link to what they created; Re-run actions; a deep link opens the delivery; a test can run the actions", async () => {
  state.triggers = [trigger({ actions: [{ id: "pb", kind: "playbook", enabled: true, playbook: "onboarding" }, { id: "nt", kind: "notify", enabled: true, channel: "telegram", body: "x" }] })];
  state.deliveries = [delivery("tdl_1", {
    body: { email: "ada@example.com" }, mapped: { email: "ada@example.com" }, actionsStatus: "partial", actionsRequestedBy: "ada@example.com",
    actions: [
      { actionId: "pb", kind: "playbook", status: "done", attempts: 1, queuedAt: "2026-11-26T10:00:00Z", startedAt: "2026-11-26T10:00:01Z", endedAt: "2026-11-26T10:00:02Z", refs: { playbook: "onboarding", missionId: "m-77", missionName: "onboarding" } },
      { actionId: "nt", kind: "notify", status: "failed", attempts: 3, queuedAt: "2026-11-26T10:00:00Z", error: "Channel \"telegram\" refused" },
    ],
    previousActions: [{ status: "failed", runs: [] }],
  })];
  await render("/triggers?trigger=tally-signup-3f9a1c2e&delivery=tdl_1");
  const dialog = $('[data-testid="delivery-dialog"]')!;
  expect(dialog.querySelector('[data-action-status="partial"]')).toBeTruthy();
  expect(dialog.querySelector('[data-run="pb"] a[data-ref="/missions/m-77"]')!.textContent).toBe("Mission onboarding");
  expect(dialog.querySelector('[data-run="nt"]')!.textContent).toContain("3 attempts");
  expect(dialog.querySelector('[data-run="nt"]')!.textContent).toContain("refused");
  expect(dialog.textContent).toContain("for ada@example.com");
  expect(dialog.textContent).toContain("Earlier runs: failed");
  await click(buttons(/Re-run actions/)[0]!);
  expect(state.calls.find((c) => c.fn === "rerunActions")!.args).toEqual(["tally-signup-3f9a1c2e", "tdl_1"]);
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await flush();
  expect($('[data-delivery="tdl_1"] [data-action-status="partial"]')).toBeTruthy();
  await click(document.querySelector('button[aria-label="Run the actions"]')!);
  await click(buttons(/Send test/)[0]!);
  expect(state.calls.find((c) => c.fn === "sendTriggerTest")!.args[1]).toMatchObject({ runActions: true });
  expect($('[data-trigger="tally-signup-3f9a1c2e"] [data-testid="row-actions"]')!.textContent).toBe("2 actions");
});

test("a task or mission started by a trigger links to its delivery", async () => {
  const { OriginLink } = await import("../src/components/triggers/origin-link");
  await act(async () => root.render(<MemoryRouter><OriginLink origin={{ kind: "trigger", triggerId: "tally-signup-3f9a1c2e", deliveryId: "tdl_1", triggerName: "Tally signup" }} /></MemoryRouter>));
  const a = $<HTMLAnchorElement>('[data-testid="origin-link"]')!;
  expect(a.getAttribute("href")).toBe("/triggers?trigger=tally-signup-3f9a1c2e&delivery=tdl_1");
  expect(a.textContent).toBe("Trigger Tally signup");
});
