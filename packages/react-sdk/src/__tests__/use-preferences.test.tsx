import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePreferences } from "../hooks/use-preferences.js";
import { createMockClient, createMockStore, createWrapper } from "./helpers.js";

describe("usePreferences", () => {
  it("loads the member's preferences and merges updates", async () => {
    const client = createMockClient({
      getPreferences: vi.fn().mockResolvedValue({
        member: "ale@polpo.sh",
        preferences: { chatNavigation: { lastSessionId: "s1", sidePanelOpen: true } },
      }),
      updatePreferences: vi.fn().mockResolvedValue({
        member: "ale@polpo.sh",
        preferences: { chatNavigation: { lastSessionId: "s2", sidePanelOpen: true, updatedAt: "2026-11-22T10:00:00Z" } },
      }),
    });
    const { result } = renderHook(() => usePreferences(), { wrapper: createWrapper(client, createMockStore()) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.member).toBe("ale@polpo.sh");
    expect(result.current.preferences.chatNavigation?.lastSessionId).toBe("s1");

    await act(async () => { await result.current.update({ chatNavigation: { lastSessionId: "s2" } }); });
    expect(client.updatePreferences).toHaveBeenCalledWith({ chatNavigation: { lastSessionId: "s2" } });
    expect(result.current.preferences.chatNavigation).toMatchObject({ lastSessionId: "s2", sidePanelOpen: true });
  });
});
