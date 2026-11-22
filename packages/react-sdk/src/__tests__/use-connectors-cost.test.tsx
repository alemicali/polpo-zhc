import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useConnectors, connectorLabel } from "../hooks/use-connectors.js";
import { useMissionCost } from "../hooks/use-mission-cost.js";
import { createMockClient, createMockStore, createWrapper, fakeMission } from "./helpers.js";
import type { Connector, MissionCost } from "@polpo-ai/sdk";

const connector = (over: Partial<Connector>): Connector => ({
  id: "gmail", name: "Gmail", kind: "mcp", transport: { type: "http" }, auth: { type: "oauth" },
  access: { agents: [], polpo: true }, enabled: true, createdAt: "2026-11-22T00:00:00Z", ...over,
});

describe("useConnectors", () => {
  it("lists the connectors; with an agent, only the ones it may use; several accounts of one app keep their own ids", async () => {
    const all = [
      connector({ id: "gmail", account: "ada@acme.com", access: { agents: ["dev"], polpo: true } }),
      connector({ id: "gmail-2", name: "Gmail – info@acme.com", account: "info@acme.com", catalogId: "gmail", access: { agents: "*", polpo: false } }),
      connector({ id: "linear", name: "Linear", access: { agents: ["ops"], polpo: true } }),
    ];
    const client = createMockClient({ getConnectors: vi.fn().mockResolvedValue(all) });
    const wrapper = createWrapper(client, createMockStore());
    const { result } = renderHook(() => useConnectors({ agent: "dev" }), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.connectors.map((c) => c.id)).toEqual(["gmail", "gmail-2"]);
    expect(result.current.connectors.map(connectorLabel)).toEqual(["Gmail – ada@acme.com", "Gmail – info@acme.com"]);
  });
});

describe("useMissionCost", () => {
  it("reads the full cost from the mission and sets the budget", async () => {
    const cost = { currency: "USD", usd: 0.62, harnessUsd: 0.42, modelUsd: 0.2, tokens: 10, runs: 3, tasks: 2, unpricedRuns: 0, runsActive: 0, partial: false, byAgent: [], byEngine: [], budgetUsd: 0.5, overBudget: true } as MissionCost;
    const getMission = vi.fn().mockResolvedValue(fakeMission({ id: "m1", budgetUsd: 0.5, cost }));
    const updateMission = vi.fn().mockResolvedValue(fakeMission({ id: "m1" }));
    const client = createMockClient({ getMission, updateMission });
    const wrapper = createWrapper(client, createMockStore());
    const { result } = renderHook(() => useMissionCost("m1"), { wrapper });
    await waitFor(() => expect(result.current.cost?.overBudget).toBe(true));
    await act(async () => { await result.current.setBudget(null); });
    expect(updateMission).toHaveBeenCalledWith("m1", { budgetUsd: null });
  });
});
