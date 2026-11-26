import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePeers, useSlackStatus } from "../hooks/use-channels.js";
import { useWaContacts } from "../hooks/use-whatsapp-business.js";
import { createMockClient, createMockStore, createWrapper } from "./helpers.js";
import type { ChannelPeer, PolpoClient, SlackStatus, WaBusinessContact } from "@polpo-ai/sdk";

const slack = (secrets: SlackStatus["secrets"]): SlackStatus => ({
  channel: "slack", inbound: true, secrets, state: secrets.botToken && secrets.appToken ? "connected" : "not-configured", received: 0,
});

describe("useSlackStatus", () => {
  let client: PolpoClient;
  let wrapper: React.ComponentType<{ children: React.ReactNode }>;
  let current: SlackStatus;

  beforeEach(() => {
    current = slack({ botToken: false, appToken: false });
    client = createMockClient({
      getSlackStatus: vi.fn().mockImplementation(async () => current),
      getSlackChannels: vi.fn().mockImplementation(async () => [current]),
      setSlackSecrets: vi.fn().mockImplementation(async (_c: string, s: Record<string, string>) => {
        current = slack({ botToken: current.secrets.botToken || !!s.botToken, appToken: current.secrets.appToken || !!s.appToken });
        return { secrets: current.secrets };
      }),
      removeSlackSecret: vi.fn().mockResolvedValue({ secrets: { botToken: false, appToken: true } }),
      testSlack: vi.fn().mockResolvedValue({ ok: true, status: current }),
    });
    wrapper = createWrapper(client, createMockStore());
  });

  it("loads the status, stores the tokens (write-only) and refreshes", async () => {
    const { result } = renderHook(() => useSlackStatus("slack", 0), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.status?.state).toBe("not-configured");
    await act(async () => { await result.current.setSecrets({ botToken: "xoxb-1", appToken: "xapp-1" }); });
    expect(client.setSlackSecrets).toHaveBeenCalledWith("slack", { botToken: "xoxb-1", appToken: "xapp-1" });
    expect(result.current.status?.state).toBe("connected");
    expect(await result.current.test()).toBe(true);
    await act(async () => { await result.current.removeSecret("botToken"); });
    expect(client.removeSlackSecret).toHaveBeenCalledWith("slack", "botToken");
  });

  it("lists every Slack channel without a name", async () => {
    const { result } = renderHook(() => useSlackStatus(undefined, 0), { wrapper });
    await waitFor(() => expect(result.current.channels).toHaveLength(1));
    expect(client.getSlackChannels).toHaveBeenCalled();
    await expect(result.current.setSecrets({ botToken: "x" })).rejects.toThrow("Say which Slack channel");
  });
});

describe("usePeers", () => {
  it("loads peers and presence, links two identities", async () => {
    const peers: ChannelPeer[] = [
      { id: "slack:U1", channel: "slack", externalId: "U1", firstSeenAt: "", lastSeenAt: "" },
      { id: "telegram:2", channel: "telegram", externalId: "2", firstSeenAt: "", lastSeenAt: "" },
    ];
    const client = createMockClient({
      getPeers: vi.fn().mockResolvedValue(peers),
      getPeerPresence: vi.fn().mockResolvedValue([{ peerId: "slack:U1", channel: "slack", activity: "chatting", lastActivityAt: "" }]),
      linkPeers: vi.fn().mockResolvedValue({ peerId: "slack:U1", linkedTo: "telegram:2" }),
    });
    const { result } = renderHook(() => usePeers(undefined, 0), { wrapper: createWrapper(client, createMockStore()) });
    await waitFor(() => expect(result.current.peers).toHaveLength(2));
    expect(result.current.presence["slack:U1"]?.activity).toBe("chatting");
    await act(async () => { await result.current.link("slack:U1", "telegram:2"); });
    expect(client.linkPeers).toHaveBeenCalledWith("slack:U1", "telegram:2");
  });

  it("is unavailable while no channel takes messages", async () => {
    const client = createMockClient({ getPeers: vi.fn().mockRejectedValue(new Error("Channel gateway not configured")), getPeerPresence: vi.fn().mockResolvedValue([]) });
    const { result } = renderHook(() => usePeers(undefined, 0), { wrapper: createWrapper(client, createMockStore()) });
    await waitFor(() => expect(result.current.unavailable).toBe(true));
  });
});

describe("useWaContacts", () => {
  it("records an opt-out and erases a contact", async () => {
    let contacts: WaBusinessContact[] = [{ channel: "shop", waId: "39333", optIn: null, optOut: null, createdAt: "", updatedAt: "" }];
    const client = createMockClient({
      getWaBusinessContacts: vi.fn().mockImplementation(async () => contacts),
      setWaBusinessOptIn: vi.fn().mockImplementation(async () => { contacts = [{ ...contacts[0]!, optOut: { at: "", keyword: "operator" } }]; return contacts[0]; }),
      deleteWaBusinessContact: vi.fn().mockImplementation(async () => { contacts = []; return { deleted: true }; }),
    });
    const { result } = renderHook(() => useWaContacts("shop"), { wrapper: createWrapper(client, createMockStore()) });
    await waitFor(() => expect(result.current.contacts).toHaveLength(1));
    await act(async () => { await result.current.setOptIn("39333", false); });
    expect(client.setWaBusinessOptIn).toHaveBeenCalledWith("shop", "39333", false, undefined);
    expect(result.current.contacts[0]?.optOut).toBeTruthy();
    await act(async () => { await result.current.erase("39333"); });
    expect(client.deleteWaBusinessContact).toHaveBeenCalledWith("shop", "39333");
    expect(result.current.contacts).toEqual([]);
  });
});
