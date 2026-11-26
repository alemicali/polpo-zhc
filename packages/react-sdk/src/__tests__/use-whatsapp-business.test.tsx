import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  useWaAccountEvents, useWaAnalytics, useWaBlocked, useWaBusinessEvents, useWaBusinessProfile, useWaBusinessStatus, useWaContacts,
  useWaConversation, useWaMedia, useWaPending, useWaPhone, useWaTemplates,
} from "../hooks/use-whatsapp-business.js";
import { createMockClient, createMockStore, createWrapper } from "./helpers.js";
import type { PolpoStore, WaBusinessConversation, WaBusinessMessage, WaBusinessStatus } from "@polpo-ai/sdk";

const ev = (id: string, event: string, data: Record<string, unknown>) => ({ id, event, data, timestamp: "2026-11-26T10:00:00.000Z" });
const apply = (store: PolpoStore, e: ReturnType<typeof ev>) => (store as unknown as { applyEvent: (e: unknown) => void }).applyEvent(e);

const conversation = (n: number): WaBusinessConversation => ({
  contact: { channel: "shop", waId: "39333", optIn: null, optOut: null, createdAt: "", updatedAt: "" },
  window: { open: true }, optedOut: false,
  messages: Array.from({ length: n }, (_, i) => ({ id: `wamid.${i}`, channel: "shop", waId: "39333", direction: "in", type: "text", status: "received", statuses: [], createdAt: "", updatedAt: "" })),
});

describe("useWaBusinessStatus", () => {
  it("refetches on channel:wabiz-event for its channel only", async () => {
    const status = { channel: "shop" } as WaBusinessStatus;
    const client = createMockClient({ getWaBusinessStatus: vi.fn().mockResolvedValue(status) });
    const store = createMockStore();
    const { result } = renderHook(() => useWaBusinessStatus("shop"), { wrapper: createWrapper(client, store) });
    await waitFor(() => expect(result.current.status?.channel).toBe("shop"));
    expect(client.getWaBusinessStatus).toHaveBeenCalledTimes(1);
    act(() => apply(store, ev("e1", "channel:wabiz-event", { channel: "other", kind: "order", data: {} })));
    act(() => apply(store, ev("e2", "channel:wabiz-event", { channel: "shop", kind: "account", data: { field: "phone_number_quality_update" } })));
    await waitFor(() => expect(client.getWaBusinessStatus).toHaveBeenCalledTimes(2));
  });
});

describe("useWaConversation", () => {
  it("sends any message type, a template, a reaction and a read receipt, then refreshes", async () => {
    let n = 1;
    const client = createMockClient({
      getWaBusinessConversation: vi.fn().mockImplementation(async () => conversation(n)),
      sendWaBusinessMessage: vi.fn().mockImplementation(async () => { n++; return { status: "sent", ids: ["wamid.x"] }; }),
      sendWaBusinessTemplate: vi.fn().mockResolvedValue({ status: "pending_approval", id: "pending_1", note: "" }),
      reactWaBusiness: vi.fn().mockResolvedValue({ status: "sent", ids: ["wamid.r"] }),
      markWaBusinessRead: vi.fn().mockResolvedValue({ read: "wamid.0" }),
    });
    const store = createMockStore();
    const { result } = renderHook(() => useWaConversation("shop", "39333"), { wrapper: createWrapper(client, store) });
    await waitFor(() => expect(result.current.conversation?.messages).toHaveLength(1));
    const file = { data: "aGVsbG8=", mimeType: "image/png", filename: "a.png" };
    await act(async () => { await result.current.send({ type: "media", kind: "image", caption: "hi" }, file); });
    expect(client.sendWaBusinessMessage).toHaveBeenCalledWith("shop", { to: "39333", message: { type: "media", kind: "image", caption: "hi" }, file });
    expect(result.current.conversation?.messages).toHaveLength(2);
    await act(async () => { await result.current.send({ type: "buttons", body: "Pick", buttons: [{ id: "a", title: "A" }] }); });
    expect(client.sendWaBusinessMessage).toHaveBeenLastCalledWith("shop", { to: "39333", message: { type: "buttons", body: "Pick", buttons: [{ id: "a", title: "A" }] } });
    const r = await result.current.sendTemplate({ template: "order", components: { body: { name: "Mario" } }, queue: true });
    expect(r.status).toBe("pending_approval");
    expect(client.sendWaBusinessTemplate).toHaveBeenCalledWith("shop", { to: "39333", template: "order", components: { body: { name: "Mario" } }, queue: true });
    await act(async () => { await result.current.react("wamid.0", "👍"); });
    expect(client.reactWaBusiness).toHaveBeenCalledWith("shop", { to: "39333", messageId: "wamid.0", emoji: "👍" });
    await act(async () => { await result.current.markRead("wamid.0", true); });
    expect(client.markWaBusinessRead).toHaveBeenCalledWith("shop", "wamid.0", { typing: true });
    // a structured event (a flow completed) refreshes the transcript
    const calls = (client.getWaBusinessConversation as ReturnType<typeof vi.fn>).mock.calls.length;
    act(() => apply(store, ev("e3", "channel:wabiz-event", { channel: "shop", kind: "flow", data: {} })));
    await waitFor(() => expect((client.getWaBusinessConversation as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls + 1));
  });
});

describe("useWaContacts", () => {
  it("blocks and unblocks a contact", async () => {
    const client = createMockClient({
      getWaBusinessContacts: vi.fn().mockResolvedValue([{ channel: "shop", waId: "39333", optIn: null, optOut: null, createdAt: "", updatedAt: "" }]),
      blockWaBusinessUsers: vi.fn().mockResolvedValue({ done: ["39333"], failed: [] }),
    });
    const { result } = renderHook(() => useWaContacts("shop"), { wrapper: createWrapper(client, createMockStore()) });
    await waitFor(() => expect(result.current.contacts).toHaveLength(1));
    await act(async () => { await result.current.setBlocked("39333", true); });
    expect(client.blockWaBusinessUsers).toHaveBeenCalledWith("shop", ["39333"], true);
  });
});

describe("useWaTemplates", () => {
  it("creates, edits and deletes a template, syncing after each", async () => {
    const client = createMockClient({
      getWaBusinessTemplates: vi.fn().mockResolvedValue({ templates: [] }),
      syncWaBusinessTemplates: vi.fn().mockResolvedValue({ templates: [{ id: "1", name: "hello", language: "it", status: "PENDING", category: "UTILITY", components: [] }], syncedAt: "x" }),
      createWaBusinessTemplate: vi.fn().mockResolvedValue({ id: "1", status: "PENDING", category: "UTILITY" }),
      editWaBusinessTemplate: vi.fn().mockResolvedValue({ id: "1", edited: true }),
      deleteWaBusinessTemplate: vi.fn().mockResolvedValue({ template: "hello", deleted: true }),
    });
    const { result } = renderHook(() => useWaTemplates("shop"), { wrapper: createWrapper(client, createMockStore()) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const def = { name: "hello", language: "it", category: "UTILITY" as const, components: [{ type: "BODY", text: "Ciao {{1}}" }] };
    await act(async () => { await result.current.create(def); });
    expect(client.createWaBusinessTemplate).toHaveBeenCalledWith("shop", def);
    expect(result.current.templates[0]?.status).toBe("PENDING");
    await act(async () => { await result.current.edit("1", { components: def.components }); });
    expect(client.editWaBusinessTemplate).toHaveBeenCalledWith("shop", "1", { components: def.components });
    await act(async () => { await result.current.remove("hello", "1"); });
    expect(client.deleteWaBusinessTemplate).toHaveBeenCalledWith("shop", "hello", "1");
    expect(client.syncWaBusinessTemplates).toHaveBeenCalledTimes(3);
  });
});

describe("useWaPending", () => {
  it("approves and rejects queued templates", async () => {
    let pending: WaBusinessMessage[] = [{ id: "p1", channel: "shop", waId: "39333", direction: "out", type: "template", status: "pending_approval", statuses: [], createdAt: "", updatedAt: "" }];
    const client = createMockClient({
      getWaBusinessPending: vi.fn().mockImplementation(async () => pending),
      approveWaBusinessSend: vi.fn().mockImplementation(async () => { pending = []; return { id: "p1", sentAs: "wamid.1" }; }),
      rejectWaBusinessSend: vi.fn().mockResolvedValue({ id: "p1", status: "rejected" }),
    });
    const { result } = renderHook(() => useWaPending("shop"), { wrapper: createWrapper(client, createMockStore()) });
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    await act(async () => { await result.current.approve("p1"); });
    expect(result.current.pending).toEqual([]);
    await act(async () => { await result.current.reject("p1", "wrong customer"); });
    expect(client.rejectWaBusinessSend).toHaveBeenCalledWith("shop", "p1", "wrong customer", undefined);
  });
});

describe("profile, blocked, analytics, account events, phone", () => {
  it("loads and saves the business profile", async () => {
    const client = createMockClient({
      getWaBusinessProfile: vi.fn().mockResolvedValue({ about: "Hi" }),
      updateWaBusinessProfile: vi.fn().mockResolvedValue({ about: "Open 9-18", vertical: "RETAIL" }),
    });
    const { result } = renderHook(() => useWaBusinessProfile("shop"), { wrapper: createWrapper(client, createMockStore()) });
    await waitFor(() => expect(result.current.profile?.about).toBe("Hi"));
    await act(async () => { await result.current.update({ about: "Open 9-18", vertical: "RETAIL" }); });
    expect(result.current.profile?.vertical).toBe("RETAIL");
  });

  it("lists the blocked contacts and unblocks one", async () => {
    let blocked = ["39333"];
    const client = createMockClient({
      getWaBusinessBlocked: vi.fn().mockImplementation(async () => blocked),
      blockWaBusinessUsers: vi.fn().mockImplementation(async () => { blocked = []; return { done: ["39333"], failed: [] }; }),
    });
    const { result } = renderHook(() => useWaBlocked("shop"), { wrapper: createWrapper(client, createMockStore()) });
    await waitFor(() => expect(result.current.blocked).toEqual(["39333"]));
    await act(async () => { await result.current.unblock(["39333"]); });
    expect(client.blockWaBusinessUsers).toHaveBeenCalledWith("shop", ["39333"], false);
    expect(result.current.blocked).toEqual([]);
  });

  it("reads analytics only once a query is given", async () => {
    const client = createMockClient({ getWaBusinessAnalytics: vi.fn().mockResolvedValue({ data_points: [{ start: 1, sent: 3 }] }) });
    const { result, rerender } = renderHook(({ q }) => useWaAnalytics("shop", q), {
      wrapper: createWrapper(client, createMockStore()), initialProps: { q: undefined as undefined | { kind: "messages"; start: number; end: number } },
    });
    expect(client.getWaBusinessAnalytics).not.toHaveBeenCalled();
    rerender({ q: { kind: "messages", start: 1, end: 2 } });
    await waitFor(() => expect(result.current.data).toEqual({ data_points: [{ start: 1, sent: 3 }] }));
    expect(client.getWaBusinessAnalytics).toHaveBeenCalledWith("shop", { kind: "messages", start: 1, end: 2 });
  });

  it("refreshes the account events on an account update", async () => {
    const client = createMockClient({ getWaBusinessAccountEvents: vi.fn().mockResolvedValue([{ id: "a", channel: "shop", field: "account_update", at: "", summary: "s", value: {} }]) });
    const store = createMockStore();
    const { result } = renderHook(() => useWaAccountEvents("shop"), { wrapper: createWrapper(client, store) });
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    act(() => apply(store, ev("e4", "channel:wabiz-event", { channel: "shop", kind: "reaction", data: {} })));
    act(() => apply(store, ev("e5", "channel:wabiz-event", { channel: "shop", kind: "account", data: { field: "account_alerts" } })));
    await waitFor(() => expect(client.getWaBusinessAccountEvents).toHaveBeenCalledTimes(2));
  });

  it("sets the webhook override and runs a phone action", async () => {
    const client = createMockClient({
      getWaBusinessWebhookOverride: vi.fn().mockResolvedValue({ current: { application: "https://a" } }),
      setWaBusinessWebhookOverride: vi.fn().mockResolvedValue({ callbackUrl: "https://me", current: { phoneNumber: "https://me" } }),
      waBusinessPhoneAction: vi.fn().mockResolvedValue({ action: "set_pin", done: true }),
    });
    const { result } = renderHook(() => useWaPhone("shop"), { wrapper: createWrapper(client, createMockStore()) });
    await waitFor(() => expect(result.current.webhook?.current.application).toBe("https://a"));
    await act(async () => { await result.current.setOverride(true); });
    expect(result.current.webhook?.current.phoneNumber).toBe("https://me");
    await act(async () => { await result.current.action({ action: "set_pin", pin: "123456" }); });
    expect(client.waBusinessPhoneAction).toHaveBeenCalledWith("shop", { action: "set_pin", pin: "123456" });
  });
});

describe("useWaBusinessEvents and useWaMedia", () => {
  it("lists the live structured events of a channel, newest first", () => {
    const store = createMockStore();
    const { result } = renderHook(() => useWaBusinessEvents("shop"), { wrapper: createWrapper(createMockClient(), store) });
    act(() => apply(store, ev("1", "channel:wabiz-event", { channel: "shop", kind: "order", data: { total: 3 } })));
    act(() => apply(store, ev("2", "channel:wabiz-event", { channel: "other", kind: "order", data: {} })));
    act(() => apply(store, ev("3", "channel:wabiz-event", { channel: "shop", kind: "payment", data: { status: "captured" } })));
    expect(result.current.events.map((e) => e.kind)).toEqual(["payment", "order"]);
  });

  it("fetches a message's file as an object URL", async () => {
    const create = vi.fn(() => "blob:x");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const client = createMockClient({ getWaBusinessMedia: vi.fn().mockResolvedValue({ contentType: "image/png", bytes: new ArrayBuffer(4), filename: "a.png" }) });
    const { result, unmount } = renderHook(() => useWaMedia("shop", "wamid.1"), { wrapper: createWrapper(client, createMockStore()) });
    await waitFor(() => expect(result.current.url).toBe("blob:x"));
    expect(result.current.contentType).toBe("image/png");
    unmount();
    expect(revoke).toHaveBeenCalledWith("blob:x");
    vi.unstubAllGlobals();
  });
});
