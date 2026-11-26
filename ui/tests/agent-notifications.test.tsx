/**
 * The agent's Notifications section: the send_notification toggle (added to / removed from
 * allowedTools), the channels it may post to with their targets, "every channel", a channel the
 * allowlist names that is not configured, the rate limit, and saving through the agent update.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Agent = { name: string; allowedTools?: string[]; notifyChannels?: unknown; notifyRateLimit?: number };

const state = vi.hoisted(() => ({
  agent: { name: "lead-notifier" } as Agent,
  updates: [] as Array<{ name: string; req: Record<string, unknown> }>,
  refetched: 0,
  channels: {} as Record<string, { type: string }>,
}));

vi.mock("@polpo-ai/react", () => ({
  useAgents: () => ({
    updateAgent: async (name: string, req: Record<string, unknown>) => { state.updates.push({ name, req }); return { name }; },
  }),
  usePolpo: () => ({ client: clientStub }),
}));
const clientStub = { getConfig: async () => ({ settings: { notifications: { channels: state.channels } } }) };
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../src/components/agents/agent-detail-context", () => ({
  useAgentDetail: () => ({
    state: { agent: state.agent },
    actions: { refetch: async () => { state.refetched += 1; } },
    meta: { agentName: state.agent.name },
  }),
}));

import { AgentNotificationsSection } from "../src/components/agents/agent-notifications-section";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.updates = [];
  state.refetched = 0;
  state.channels = { slack: { type: "slack" }, telegram: { type: "telegram" } };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const byText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.trim() === text);
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const type = async (el: HTMLInputElement | null, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
};

async function render(agent: Agent) {
  state.agent = agent;
  await act(async () => root.render(<AgentNotificationsSection />));
  await flush();
}

describe("the agent's Notifications section", () => {
  test("turning it on: the tool joins allowedTools, a Slack channel with a target is saved as the allowlist", async () => {
    await render({ name: "lead-notifier", allowedTools: ["read", "write"] });
    expect($('[data-channel="slack"]')?.textContent).toMatch(/slack/);
    expect($('[data-channel="telegram"]')).not.toBeNull();
    expect(byText("Save")).toBeUndefined();

    await click($('button[aria-label="send_notification tool"]'));
    expect($('[data-testid="notify-no-channels"]')?.textContent).toMatch(/at least one channel/);
    await click($('button[aria-label="Channel slack"]'));
    expect($('[data-testid="notify-no-channels"]')).toBeNull();
    await type($<HTMLInputElement>('input[aria-label="Targets for slack"]'), "C0LEADBF, C0OPS");
    await type($<HTMLInputElement>('input[aria-label="Messages per minute"]'), "3");
    await click(byText("Save"));

    expect(state.updates).toEqual([{ name: "lead-notifier", req: {
      notifyChannels: [{ channel: "slack", targets: ["C0LEADBF", "C0OPS"] }],
      notifyRateLimit: 3,
      allowedTools: ["read", "write", "send_notification"],
    } }]);
    expect(state.refetched).toBe(1);
  });

  test("an agent with default tools keeps its core tools when the tool is turned on; every channel is \"*\"", async () => {
    await render({ name: "ops" });
    await click($('button[aria-label="send_notification tool"]'));
    await click($('button[aria-label="All channels"]'));
    expect($('[data-testid="notify-channels"]')).toBeNull();
    await click(byText("Save"));
    expect(state.updates[0]!.req).toEqual({
      notifyChannels: "*", notifyRateLimit: null,
      allowedTools: ["read", "write", "edit", "bash", "glob", "grep", "ls", "send_notification"],
    });
  });

  test("the stored allowlist is shown (targets, a channel not configured); turning the tool off removes it and keeps the rest", async () => {
    await render({
      name: "lead-notifier", allowedTools: ["read", "send_notification"], notifyRateLimit: 10,
      notifyChannels: [{ channel: "slack", targets: ["C0LEADBF"] }, { channel: "email-ops" }],
    });
    expect($<HTMLInputElement>('input[aria-label="Targets for slack"]')?.value).toBe("C0LEADBF");
    expect($('[data-channel="email-ops"]')?.textContent).toMatch(/not configured/);
    expect($<HTMLInputElement>('input[aria-label="Messages per minute"]')?.value).toBe("10");

    await click($('button[aria-label="send_notification tool"]'));
    expect($('[data-testid="notify-tool-off"]')).not.toBeNull();
    await click(byText("Save"));
    expect(state.updates[0]!.req).toEqual({
      notifyChannels: [{ channel: "slack", targets: ["C0LEADBF"] }, { channel: "email-ops" }],
      notifyRateLimit: 10,
      allowedTools: ["read"],
    });
  });

  test("removing every channel clears the allowlist (null); Cancel restores the stored values", async () => {
    await render({ name: "lead-notifier", allowedTools: ["send_notification"], notifyChannels: [{ channel: "telegram" }] });
    await click($('button[aria-label="Channel telegram"]'));
    expect($('[data-testid="notify-no-channels"]')).not.toBeNull();
    await click(byText("Cancel"));
    expect($<HTMLButtonElement>('button[aria-label="Channel telegram"]')?.getAttribute("aria-checked")).toBe("true");
    await click($('button[aria-label="Channel telegram"]'));
    await click(byText("Save"));
    expect(state.updates[0]!.req).toEqual({ notifyChannels: null, notifyRateLimit: null });
  });
});
