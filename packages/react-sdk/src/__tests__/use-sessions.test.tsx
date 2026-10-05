import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession, PolpoClient, PolpoStore } from "@polpo-ai/sdk";
import { useSessions } from "../hooks/use-sessions.js";
import { createMockClient, createMockStore, createWrapper } from "./helpers.js";

describe("useSessions live updates", () => {
  let client: PolpoClient;
  let store: PolpoStore;
  let wrapper: React.ComponentType<{ children: React.ReactNode }>;

  beforeEach(() => {
    localStorage.clear();
    const sessions: ChatSession[] = [{ id: "session-1", title: "Initial", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", messageCount: 1 }];
    client = createMockClient({
      getSessions: vi.fn().mockResolvedValue({ sessions }),
      getSessionMessages: vi.fn().mockResolvedValue({ session: sessions[0], messages: [] }),
      renameSession: vi.fn().mockResolvedValue({ renamed: true }),
      setSessionStarred: vi.fn().mockResolvedValue({ starred: true }),
      deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
    });
    store = createMockStore();
    wrapper = createWrapper(client, store);
  });

  it("refetches for consecutive session events even with a one-event window", async () => {
    renderHook(() => useSessions(), { wrapper });
    await waitFor(() => expect(client.getSessions).toHaveBeenCalledTimes(1));

    act(() => store.applyEvent({ id: "event-1", event: "session:updated", data: { sessionId: "session-1", starred: true }, timestamp: new Date().toISOString() }));
    await waitFor(() => expect(client.getSessions).toHaveBeenCalledTimes(2));

    act(() => store.applyEvent({ id: "event-2", event: "session:deleted", data: { sessionId: "session-1" }, timestamp: new Date().toISOString() }));
    await waitFor(() => expect(client.getSessions).toHaveBeenCalledTimes(3));
  });
});
