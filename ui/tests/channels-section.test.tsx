/**
 * Configuration → Channels like the Connectors page: the configured list, the "Add channel"
 * catalog, the channel's sheet, the deep link (?channel=), and every setting and action of the
 * old cards and dialog still reachable from the sheet.
 */
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationChannelConfig } from "@polpo-ai/react";

const wabizStatus = {
  channel: "shop", graphApiVersion: "v23.0", audience: "customers", agent: "support", inbound: true,
  secrets: { accessToken: true, appSecret: true, verifyToken: true }, state: "receiving", missing: [],
  callbackUrl: "https://host.ts.net/api/v1/channels/whatsapp-business/webhooks/shop",
  funnelCommand: "tailscale funnel --bg --set-path /api/v1/channels/whatsapp-business/webhooks http://127.0.0.1:3890",
  note: "Expose the path.", counts: { accepted: 3, ignored: 0, rejected: 0, error: 0 }, inbox: 0, pendingApprovals: 0, sentToday: 1,
  limits: { businessInitiatedPerDay: 50, perAgentPerDay: {} }, lastEventAt: new Date(Date.now() - 5 * 60_000).toISOString(),
};
const live = vi.hoisted(() => ({
  slack: [] as Array<Record<string, unknown>>,
  setSecrets: (() => {}) as (...a: unknown[]) => unknown,
  peers: [] as Array<Record<string, unknown>>,
  presence: {} as Record<string, unknown>,
  link: (() => {}) as (...a: unknown[]) => unknown,
  contacts: [] as Array<Record<string, unknown>>,
  setOptIn: (() => {}) as (...a: unknown[]) => unknown,
  erase: (() => {}) as (...a: unknown[]) => unknown,
}));
vi.mock("@polpo-ai/react", () => ({
  usePolpo: () => ({ client: { getWaBusinessPending: vi.fn(async () => []), testWaBusiness: vi.fn(), generateWaBusinessVerifyToken: vi.fn() } }),
  useWaBusinessStatus: (channel?: string) => ({
    status: channel === "shop" || !channel ? wabizStatus : undefined, channels: [wabizStatus], isLoading: false, error: null, refetch: vi.fn(async () => {}),
  }),
  useEvents: () => ({ events: [] }),
  useSlackStatus: (channel?: string) => {
    const channels = live.slack.filter((c) => !channel || c.channel === channel);
    return { channels, status: channels[0], isLoading: false, error: null, refetch: vi.fn(), setSecrets: live.setSecrets, removeSecret: vi.fn(), test: vi.fn(async () => true) };
  },
  usePeers: () => ({ peers: live.peers, presence: live.presence, isLoading: false, unavailable: false, refetch: vi.fn(), link: live.link }),
  useWaContacts: () => ({ contacts: live.contacts, isLoading: false, error: null, refetch: vi.fn(), setOptIn: live.setOptIn, erase: live.erase, setBlocked: vi.fn(async () => ({ done: [], failed: [] })) }),
  useWaTemplates: () => ({ templates: [], isLoading: false, error: null, sync: vi.fn(), create: vi.fn(), edit: vi.fn(), remove: vi.fn() }),
  useWaConversation: () => ({ conversation: undefined, isLoading: false, error: null, refetch: vi.fn(), send: vi.fn(), sendTemplate: vi.fn(), react: vi.fn(), markRead: vi.fn() }),
  useWaBusinessProfile: () => ({ profile: {}, isLoading: false, error: null, refetch: vi.fn(), update: vi.fn() }),
  useWaBlocked: () => ({ blocked: [], isLoading: false, error: null, refetch: vi.fn(), block: vi.fn(), unblock: vi.fn() }),
  useWaAnalytics: () => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() }),
  useWaAccountEvents: () => ({ events: [], isLoading: false, error: null, refetch: vi.fn() }),
  useWaPhone: () => ({ webhook: undefined, isLoading: false, error: null, refetch: vi.fn(), setOverride: vi.fn(), action: vi.fn() }),
  useWaMedia: () => ({ url: undefined, isLoading: false, error: null }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ChannelsSection, type ChannelApiAction } from "../src/components/channels/channels-section";
import {
  CHANNEL_CATALOG, channelState, filterChannelCatalog, filterChannels, nextChannelName, timeAgo,
} from "../src/components/channels/channel-catalog";

const SAVED: Record<string, NotificationChannelConfig> = {
  ops: { type: "telegram", botToken: "••••abcd", chatId: "123", gateway: { enableInbound: true, dmPolicy: "pairing", agent: "ops-agent" } },
  team: { type: "whatsapp", profileDir: "default", chatId: "+3933", gateway: { enableInbound: true, dmPolicy: "pairing" } },
  shop: { type: "whatsapp-business", phoneNumberId: "111", wabaId: "222", business: { audience: "customers" }, gateway: { enableInbound: true, dmPolicy: "open", agent: "support" } },
  eng: { type: "slack", webhookUrl: "••••hook" },
  mail: { type: "email", provider: "resend", apiKey: "••••key1", from: "a@b.c", to: ["x@y.z"] },
  hook: { type: "webhook", url: "https://example.com/in", gateway: { enableInbound: true, dmPolicy: "open" }, inboundSecret: "••••sec1" },
  browser: { type: "push", ttl: 3600, urgency: "normal" },
  speaker: { type: "voice" as NotificationChannelConfig["type"], url: "http://127.0.0.1:8766" },
};

let root: Root;
let container: HTMLDivElement;
let actions: ChannelApiAction[];
let fetchMock: ReturnType<typeof vi.fn>;
const probe = { location: "" };

function LocationProbe() {
  const loc = useLocation();
  useEffect(() => { probe.location = `${loc.pathname}${loc.search}`; });
  return null;
}

/** The section with a fake config store: PUT / DELETE change the channels it shows. */
function Harness({ initial }: { initial: Record<string, NotificationChannelConfig> }) {
  const [channels, setChannels] = useState(initial);
  return (
    <ChannelsSection
      channels={channels}
      onUpdateConfig={async (action) => {
        actions.push(action);
        const name = decodeURIComponent(action.path.slice(1));
        setChannels((prev) => {
          const next = { ...prev };
          if (action.method === "DELETE") delete next[name];
          else next[name] = action.body as NotificationChannelConfig;
          return next;
        });
      }}
    />
  );
}

async function render(url = "/config?section=channels", initial = SAVED) {
  await act(async () => root.render(
    <MemoryRouter initialEntries={[url]}><LocationProbe /><Harness initial={initial} /></MemoryRouter>,
  ));
  await act(async () => {});
}

const sheet = () => document.querySelector<HTMLElement>('[data-testid="channel-sheet"]');
const buttons = (scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")];
const byLabel = (label: string, scope: ParentNode = document) => scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (text: string | RegExp, scope: ParentNode = document) =>
  buttons(scope).find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? "")));
async function click(el: HTMLElement | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => { el!.click(); });
  await act(async () => {});
}
/** Radix tabs switch on mousedown. */
async function selectTab(name: RegExp) {
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => name.test(t.textContent ?? ""));
  expect(tab).toBeTruthy();
  await act(async () => {
    tab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    tab!.click();
  });
  await act(async () => {});
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  actions = [];
  fetchMock = vi.fn(async (url: string) => {
    const body = String(url).includes("/whatsapp/profiles")
      ? { ok: true, data: { profiles: [{ profileDir: "default", authenticated: true, status: "authenticated", path: "" }] } }
      : String(url).includes("/test")
        ? { ok: true, data: { success: false, error: "Chat not found" } }
        : { ok: true, data: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("channel catalog (pure)", () => {
  it("states: a failed test wins, then what is missing, then the live state", () => {
    expect(channelState(SAVED.ops)).toBe("connected");
    expect(channelState(SAVED.ops, { testOk: false })).toBe("error");
    expect(channelState({ type: "telegram", botToken: "" })).toBe("needs_setup");
    expect(channelState(SAVED.shop, { waBizState: "receiving" })).toBe("receiving");
    expect(channelState(SAVED.shop, { waBizState: "not-configured" })).toBe("needs_setup");
    expect(channelState(SAVED.shop)).toBe("configured");
    expect(channelState(SAVED.team, { waLinked: false })).toBe("needs_setup");
    expect(channelState(SAVED.speaker)).toBe("configured");
  });

  it("searches the catalog and the configured channels, names new channels", () => {
    expect(filterChannelCatalog(CHANNEL_CATALOG, "meta").map((e) => e.type)).toEqual(["whatsapp-business"]);
    expect(filterChannelCatalog(CHANNEL_CATALOG, "qr").map((e) => e.type)).toEqual(["whatsapp"]);
    expect(filterChannels(Object.entries(SAVED), "support").map(([n]) => n)).toEqual(["shop"]);
    expect(nextChannelName("telegram", ["telegram", "telegram-2"])).toBe("telegram-3");
    expect(timeAgo(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe("3 h ago");
  });
});

describe("Channels section", () => {
  it("lists the configured channels as rows with mark, status, inbound, agent and last activity", async () => {
    await render();
    for (const name of Object.keys(SAVED)) expect(container.querySelector(`[data-testid="channel-row-${name}"]`)).toBeTruthy();
    const shop = container.querySelector('[data-testid="channel-row-shop"]')!;
    expect(shop.textContent).toContain("WhatsApp Business");
    expect(shop.textContent).toContain("Receiving");
    expect(shop.textContent).toContain("Inbound on");
    expect(shop.textContent).toContain("support");
    expect(shop.textContent).toContain("Last activity 5 min ago");
    expect(container.querySelector('[data-testid="channel-row-eng"]')!.textContent).toContain("Connected");
    expect(container.querySelector('[data-testid="channel-row-speaker"]')!.textContent).toContain("Configured");
  });

  it("opens the sheet from a row and keeps ?channel= in the URL while it is open", async () => {
    await render();
    await click(byLabel("Manage ops"));
    expect(sheet()?.textContent).toContain("ops");
    expect(probe.location).toContain("channel=ops");
    expect(sheet()?.querySelector('[data-testid="channel-facts"]')?.textContent).toContain("ops-agent");
    await click(byText("Cancel", sheet()!));
    expect(sheet()).toBeNull();
    expect(probe.location).not.toContain("channel=");
  });

  it("a deep link (?section=channels&channel=shop) opens that channel's sheet with its Meta connection", async () => {
    await render("/config?section=channels&channel=shop&focus=accessToken");
    expect(sheet()).toBeTruthy();
    expect(sheet()!.querySelector('[data-testid="wabiz-live"]')).toBeTruthy();
    expect(sheet()!.querySelector('[data-setup-item="shop"] input[data-setup-field="accessToken"]')).toBeTruthy();
    expect(sheet()!.querySelector('[data-testid="wabiz-callback"]')?.textContent).toBe(wabizStatus.callbackUrl);
    expect(sheet()!.querySelector('[data-testid="wabiz-funnel"]')?.textContent).toContain("tailscale funnel");
  });

  it("ignores a deep link to a channel that does not exist", async () => {
    await render("/config?section=channels&channel=nope");
    expect(sheet()).toBeNull();
  });

  it.each(CHANNEL_CATALOG.map((e) => [e.type, e.label] as const))("adds a %s channel from the catalog", async (type, label) => {
    await render("/config?section=channels", {});
    // no channels: the catalog is shown first
    expect(container.querySelector(`[data-testid="channel-catalog-${type}"]`)).toBeTruthy();
    await click(byLabel(`Add ${label}`));
    expect(sheet()?.textContent).toContain(`Add ${label}`);
    const nameInput = sheet()!.querySelector<HTMLInputElement>('input[data-setup-field="channelName"]')!;
    expect(nameInput.value).toBe(type);
    await click(byText("Add channel", sheet()!));
    expect(actions).toEqual([{ path: `/${type}`, method: "PUT", body: expect.objectContaining({ type }) }]);
    // the sheet now shows the saved channel
    expect(probe.location).toContain(`channel=${type}`);
    expect(byText("Remove", sheet()!)).toBeTruthy();
  });

  it("refuses a duplicate or invalid name for a new channel", async () => {
    await render();
    await selectTab(/Add channel/);
    await click(byLabel("Add another Slack") ?? byLabel("Add Slack"));
    const input = sheet()!.querySelector<HTMLInputElement>('input[data-setup-field="channelName"]')!;
    expect(input.value).toBe("slack");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "eng"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(byText("Add channel", sheet()!));
    expect(sheet()!.textContent).toContain('There is already a channel named "eng"');
    await act(async () => { setter.call(input, "bad name"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(byText("Add channel", sheet()!));
    expect(sheet()!.textContent).toContain("only letters, numbers, dashes, underscores");
    expect(actions).toEqual([]);
  });

  it("sends a test and shows the failure on the sheet and the row", async () => {
    await render();
    await click(byLabel("Manage ops"));
    await click(byText("Send test", sheet()!));
    expect(fetchMock.mock.calls.some(([u, init]) => String(u).endsWith("/api/v1/config/channels/ops/test") && (init as RequestInit).method === "POST")).toBe(true);
    expect(sheet()!.textContent).toContain("Chat not found");
    expect(sheet()!.querySelector('[data-testid="channel-state"]')?.textContent).toBe("Error");
  });

  it("removes a channel after the confirmation", async () => {
    await render();
    await click(byLabel("Manage eng"));
    await click(byText("Remove", sheet()!));
    const confirm = buttons().filter((b) => b.textContent?.trim() === "Remove").at(-1);
    await click(confirm);
    expect(actions).toEqual([{ path: "/eng", method: "DELETE" }]);
    expect(container.querySelector('[data-testid="channel-row-eng"]')).toBeNull();
  });

  it("saves changes made in the sheet", async () => {
    await render();
    await click(byLabel("Manage hook"));
    const url = sheet()!.querySelector<HTMLInputElement>('input[data-setup-field="url"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(url, "https://example.com/new"); url.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(byText("Save changes", sheet()!));
    expect(actions).toEqual([{ path: "/hook", method: "PUT", body: expect.objectContaining({ type: "webhook", url: "https://example.com/new", inboundSecret: "••••sec1" }) }]);
  });

  /**
   * Every setting and action of the old channel cards and edit dialog, per type, is in the sheet.
   * Texts are labels, buttons or section titles.
   */
  const REACHABLE: Record<string, string[]> = {
    // common: overview, test, remove, save
    "*": ["Overview", "Send test", "Remove", "Save changes", "Cancel", "Settings"],
    ops: ["Setup", "Bot Token", "Verify token", "Chat ID", "Routing", "DM Policy", "Idle Timeout", "Dedicated agent", "Replies go to", "Conversation", "Allow From", "Bot", "Menu", "Groups"],
    team: ["Setup", "WhatsApp profile", "Profile Directory", "Connect WhatsApp", "Logout", "Refresh", "Notification Chat ID", "Routing", "DM Policy", "Allow From", "Replies go to"],
    shop: ["Setup", "Phone number ID", "WhatsApp Business Account ID", "Who writes to it", "Graph API version", "Operators", "Business-initiated a day", "Keep messages (days)",
      "Template categories agents may send", "Templates from agents and Polpo", "Notifications outside 24 h", "Meta Cloud API", "Access token", "App secret", "Verify token",
      "Generate", "Test", "Callback URL", "Expose it (Tailscale Funnel)", "Events", "Routing", "Agent that answers customers (required)", "DM Policy", "Allow From",
      "Read receipts", "Typing indicator", "Download inbound media", "Largest file kept (MB)", "Catalog ID", "Meta app ID", "Payments in WhatsApp", "Marketing Messages API",
      "Shared Meta app", "WhatsApp Business account", "Templates", "Profile", "Phone number", "Analytics", "Account updates", "Blocked", "New template"],
    eng: ["Setup", "Channel ID", "Webhook URL", "API Key", "Slack app", "Routing"],
    mail: ["Setup", "Provider", "API Key", "From Address", "Recipients"],
    hook: ["Setup", "Notification URL", "Headers", "Routing", "Endpoint", "Secret", "New", "iOS Shortcuts", "Dedicated agent", "Replies go to", "DM Policy"],
    browser: ["Setup", "VAPID Subject", "TTL Seconds", "Urgency", "This browser", "Enable"],
    speaker: ["set up in polpo.json"],
  };

  it.each(Object.keys(SAVED))("keeps every setting and action of %s reachable from its sheet", async (name) => {
    await render(`/config?section=channels&channel=${name}`);
    await act(async () => {});
    const text = sheet()!.textContent ?? "";
    for (const label of [...REACHABLE["*"], ...REACHABLE[name]]) expect(text, `${name}: ${label}`).toContain(label);
  });

  it("shows pairing and invites for a two-way Telegram channel", async () => {
    await render("/config?section=channels&channel=ops");
    await act(async () => {});
    // ChannelAccessPanel asks for the channel's peers
    expect(fetchMock.mock.calls.some(([u]) => /\/peers|\/pairing|\/telegram/.test(String(u)))).toBe(true);
  });

  it("filters rows and catalog cards with the search", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search channels"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "slack"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(container.querySelectorAll('[data-testid^="channel-row-"]').length).toBe(1);
    await selectTab(/Add channel/);
    expect([...container.querySelectorAll('[data-testid^="channel-catalog-"]')].map((e) => e.getAttribute("data-testid"))).toEqual(["channel-catalog-slack"]);
  });
});

// ── Slack, coming soon, webhook inbound, group settings, contacts, linked identities ──

/** Radix Select: open it from the keyboard, then pick an option by its text. */
async function pick(trigger: HTMLElement | null, option: RegExp) {
  expect(trigger).toBeTruthy();
  await act(async () => { trigger!.focus(); trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  const opt = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => option.test(o.textContent ?? ""));
  expect(opt, String(option)).toBeTruthy();
  await act(async () => { opt!.focus(); opt!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await act(async () => {});
}

describe("Channels: Slack, parity controls and cleanup", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
    live.slack = [];
    live.peers = [];
    live.presence = {};
    live.contacts = [];
    live.setSecrets = vi.fn(async () => {});
    live.link = vi.fn(async () => {});
    live.setOptIn = vi.fn(async () => {});
    live.erase = vi.fn(async () => {});
  });

  it("shows Discord and inbound email as coming soon, not selectable", async () => {
    await render("/config?section=channels", {});
    for (const id of ["discord", "email-inbound"]) {
      const card = container.querySelector(`[data-testid="channel-coming-${id}"]`)!;
      expect(card.textContent).toContain("Coming soon");
      expect(card.querySelector("button")).toBeNull();
    }
    expect(byLabel("Add Discord")).toBeNull();
  });

  it("a new webhook is outbound only: no inbound part", async () => {
    await render("/config?section=channels", {});
    await click(byLabel("Add Webhook"));
    expect(sheet()!.querySelector('[data-testid="section-routing"]')).toBeNull();
    expect(sheet()!.textContent).not.toContain("iOS Shortcuts");
  });

  it("an existing webhook with inbound on keeps its Routing, endpoint and secret", async () => {
    await render("/config?section=channels&channel=hook");
    expect(sheet()!.querySelector('[data-testid="section-routing"]')).toBeTruthy();
    expect(sheet()!.textContent).toContain("iOS Shortcuts");
  });

  it("connects a Slack app: Socket Mode state, tokens saved write-only, channel messages and group settings", async () => {
    live.slack = [{ channel: "eng", inbound: true, secrets: { botToken: true, appToken: false }, state: "not-configured", received: 0 }];
    const eng: NotificationChannelConfig = { type: "slack", chatId: "C0OPS", gateway: { enableInbound: true, dmPolicy: "pairing" } };
    await render("/config?section=channels&channel=eng", { eng });
    const slack = sheet()!.querySelector('[data-testid="slack-connection"]')!;
    expect(slack.querySelector('[data-testid="slack-state"]')!.textContent).toBe("Not configured");
    expect(slack.querySelector('[data-testid="slack-secret-botToken"]')!.textContent).toContain("Stored");
    expect(slack.querySelector('[data-testid="slack-secret-appToken"]')!.textContent).toContain("Not set");
    const input = slack.querySelector<HTMLInputElement>('input[data-setup-field="appToken"]')!;
    expect(input.type).toBe("password");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "xapp-1-A1-secret"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(byText("Save", slack.querySelector('[data-testid="slack-secret-appToken"]')!));
    expect(live.setSecrets).toHaveBeenCalledWith({ appToken: "xapp-1-A1-secret" });
    expect(input.value).toBe("");
    // the row: needs setup until both tokens are in
    expect(container.querySelector('[data-testid="channel-row-eng"]')!.textContent).toContain("Needs setup");

    const routing = sheet()!.querySelector('[data-testid="section-routing"]')!;
    expect(routing.textContent).toContain("In Slack channels");
    expect(routing.textContent).toContain("Dedicated agent");
    await pick(routing.querySelector('[aria-label="In Slack channels"]'), /Every message/);
    await pick(routing.querySelector('[aria-label="Group replies"]'), /intent/);
    const threshold = routing.querySelector<HTMLInputElement>('input[aria-label="Intent threshold"]')!;
    await act(async () => { setter.call(threshold, "0.85"); threshold.dispatchEvent(new Event("input", { bubbles: true })); });
    await pick(routing.querySelector('[aria-label="Commands"]'), /Operators only/);
    await click(byText("Save changes", sheet()!));
    expect(actions.at(-1)).toEqual({ path: "/eng", method: "PUT", body: expect.objectContaining({
      type: "slack", slack: { channelMessages: "all" },
      gateway: expect.objectContaining({ enableInbound: true, groupReplies: "intent", intentThreshold: 0.85, commands: "operators" }),
    }) });
  });

  it("sets group replies, the intent threshold and commands on a Telegram channel", async () => {
    await render("/config?section=channels&channel=ops");
    const routing = sheet()!.querySelector('[data-testid="section-routing"]')!;
    expect(routing.querySelector('[data-testid="group-replies"]')).toBeTruthy();
    expect(routing.querySelector('input[aria-label="Intent threshold"]')).toBeNull();
    await pick(routing.querySelector('[aria-label="Group replies"]'), /intent/);
    expect(routing.querySelector('input[aria-label="Intent threshold"]')).toBeTruthy();
    await pick(routing.querySelector('[aria-label="Commands"]'), /Nobody/);
    await click(byText("Save changes", sheet()!));
    expect(actions.at(-1)!.body).toMatchObject({ gateway: { groupReplies: "intent", commands: "none" } });
  });

  it("records a WhatsApp Business contact's opt-out and erases a contact after confirming", async () => {
    live.contacts = [
      { channel: "shop", waId: "393331234567", name: "Mario", optIn: null, optOut: null, window: { open: true }, createdAt: "", updatedAt: "" },
      { channel: "shop", waId: "393339999999", optIn: null, optOut: { at: "", keyword: "STOP" }, window: { open: false }, createdAt: "", updatedAt: "" },
    ];
    await render("/config?section=channels&channel=shop");
    const contacts = sheet()!.querySelector('[data-testid="wabiz-contacts"]')!;
    const mario = contacts.querySelector('[data-testid="wabiz-contact-393331234567"]')!;
    expect(mario.textContent).toContain("Window open");
    await click(byText("Opt out", mario));
    expect(live.setOptIn).toHaveBeenCalledWith("393331234567", false);
    const stopped = contacts.querySelector('[data-testid="wabiz-contact-393339999999"]')!;
    expect(stopped.textContent).toContain("Opted out");
    await click(byText("Record opt-in", stopped));
    expect(live.setOptIn).toHaveBeenLastCalledWith("393339999999", true);

    await click(byLabel("Erase 393331234567"));
    expect(live.erase).not.toHaveBeenCalled();
    await click(buttons().filter((b) => b.textContent?.trim() === "Erase").at(-1));
    expect(live.erase).toHaveBeenCalledWith("393331234567");
  });

  it("shows who is active on a channel and links two identities of the same person", async () => {
    live.peers = [
      { id: "telegram:42", channel: "telegram", externalId: "42", displayName: "Alice", firstSeenAt: "", lastSeenAt: new Date().toISOString() },
      { id: "slack:UALICE", channel: "slack", externalId: "UALICE", displayName: "Alice (Slack)", firstSeenAt: "", lastSeenAt: new Date().toISOString() },
    ];
    live.presence = { "telegram:42": { peerId: "telegram:42", channel: "telegram", activity: "chatting", lastActivityAt: new Date().toISOString() } };
    await render("/config?section=channels&channel=ops");
    const links = sheet()!.querySelector('[data-testid="peer-links"]')!;
    expect(links.querySelector('[data-testid="peer-telegram:42"]')!.textContent).toContain("active · chatting");
    await pick(links.querySelector('[aria-label="Link telegram:42"]'), /Alice \(Slack\)/);
    expect(live.link).toHaveBeenCalledWith("telegram:42", "slack:UALICE");
  });
});
