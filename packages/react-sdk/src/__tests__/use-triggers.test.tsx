import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTriggerDelivery } from "../hooks/use-triggers.js";
import { createMockClient, createMockStore, createWrapper } from "./helpers.js";
import type { PolpoClient, PolpoStore, TriggerDelivery } from "@polpo-ai/sdk";

const delivery = (actionsStatus: TriggerDelivery["actionsStatus"]): TriggerDelivery => ({
  id: "tdl_1", triggerId: "form-1", receivedAt: "2026-11-26T10:00:00Z", status: "accepted", httpStatus: 202, reasons: [], bytes: 10, contractVersion: 1,
  headers: {}, query: {}, actionsStatus,
  actions: [{ actionId: "pb", kind: "playbook", status: actionsStatus === "done" ? "done" : "failed", attempts: 1, queuedAt: "2026-11-26T10:00:00Z", refs: { missionId: "m1" } }],
});

describe("useTriggerDelivery", () => {
  let client: PolpoClient;
  let store: PolpoStore;
  let wrapper: React.ComponentType<{ children: React.ReactNode }>;
  let current: TriggerDelivery;

  beforeEach(() => {
    current = delivery("failed");
    client = createMockClient({
      getTriggerDelivery: vi.fn().mockImplementation(async () => current),
      rerunTriggerActions: vi.fn().mockImplementation(async () => { current = delivery("done"); return { deliveryId: "tdl_1", actionsStatus: "queued", actions: [] }; }),
    });
    store = createMockStore();
    wrapper = createWrapper(client, store);
  });

  it("loads one delivery with its action runs and re-runs them", async () => {
    const { result } = renderHook(() => useTriggerDelivery("form-1", "tdl_1"), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.delivery?.actionsStatus).toBe("failed");
    expect(result.current.delivery?.actions?.[0]?.refs).toEqual({ missionId: "m1" });
    await act(async () => { await result.current.rerunActions(); });
    expect(client.rerunTriggerActions).toHaveBeenCalledWith("form-1", "tdl_1");
    expect(result.current.delivery?.actionsStatus).toBe("done");
  });

  it("does nothing without a delivery", async () => {
    const { result } = renderHook(() => useTriggerDelivery("form-1", undefined), { wrapper });
    expect(result.current.delivery).toBeUndefined();
    expect(client.getTriggerDelivery).not.toHaveBeenCalled();
    await expect(result.current.rerunActions()).rejects.toThrow("No delivery");
  });
});
