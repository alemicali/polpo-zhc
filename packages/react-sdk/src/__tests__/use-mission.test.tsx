import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useMission } from "../hooks/use-mission.js";
import { createMockClient, createMockStore, createWrapper, fakeMission } from "./helpers.js";

type TestStore = ReturnType<typeof createMockStore> & { markMissionsStale: () => void };

describe("useMission", () => {
  it("refetches the mission on every stale signal of a run, not only the first", async () => {
    const mission = fakeMission({ id: "mission-1" });
    const client = createMockClient({ getMission: vi.fn().mockResolvedValue(mission) });
    const store = createMockStore() as TestStore;
    store.upsertMission(mission);
    const wrapper = createWrapper(client, store);

    renderHook(() => useMission("mission-1"), { wrapper });
    expect(client.getMission).not.toHaveBeenCalled();

    act(() => store.markMissionsStale());
    await waitFor(() => expect(client.getMission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(store.getSnapshot().missionsStale).toBe(false));

    act(() => store.markMissionsStale());
    await waitFor(() => expect(client.getMission).toHaveBeenCalledTimes(2));
  });
});
