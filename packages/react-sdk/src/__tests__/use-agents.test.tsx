import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAgents } from "../hooks/use-agents.js";
import {
  createMockClient,
  createMockStore,
  createWrapper,
  fakeAgent,
  fakeTeam,
} from "./helpers.js";
import type { PolpoClient } from "@polpo-ai/sdk";
import type { PolpoStore } from "@polpo-ai/sdk";

describe("useAgents", () => {
  let client: PolpoClient;
  let store: PolpoStore;
  let wrapper: React.ComponentType<{ children: React.ReactNode }>;

  beforeEach(() => {
    const agents = [
      fakeAgent({ name: "agent-1" }),
      fakeAgent({ name: "agent-2" }),
    ];
    const teams = [
      fakeTeam({ name: "team-1", agents }),
    ];
    client = createMockClient({
      getAgents: vi.fn().mockResolvedValue(agents),
      getTeams: vi.fn().mockResolvedValue(teams),
    });
    store = createMockStore();
    wrapper = createWrapper(client, store);
  });

  it("returns agents and teams after fetch", async () => {
    const { result } = renderHook(() => useAgents(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.agents).toHaveLength(2);
    expect(result.current.agents[0].name).toBe("agent-1");
    expect(result.current.teams).toHaveLength(1);
    expect(result.current.teams[0].name).toBe("team-1");
    expect(result.current.error).toBe(null);
  });

  it("isLoading starts true, becomes false after fetch", async () => {
    const { result } = renderHook(() => useAgents(), { wrapper });

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
  });

  it("isAddingAgent is true while adding an agent", async () => {
    let resolveAdd!: (v: unknown) => void;
    (client.addAgent as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveAdd = r; }),
    );

    const { result } = renderHook(() => useAgents(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let addPromise: Promise<unknown>;
    act(() => {
      addPromise = result.current.addAgent({ name: "agent-3" });
    });

    expect(result.current.isAddingAgent).toBe(true);

    await act(async () => {
      resolveAdd({ added: true });
      await addPromise;
    });

    expect(result.current.isAddingAgent).toBe(false);
  });

  it("isRemovingAgent is true while removing an agent", async () => {
    let resolveRemove!: (v: unknown) => void;
    (client.removeAgent as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveRemove = r; }),
    );

    const { result } = renderHook(() => useAgents(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let removePromise: Promise<unknown>;
    act(() => {
      removePromise = result.current.removeAgent("agent-1");
    });

    expect(result.current.isRemovingAgent).toBe(true);

    await act(async () => {
      resolveRemove({ removed: true });
      await removePromise;
    });

    expect(result.current.isRemovingAgent).toBe(false);
  });

  it("isUpdatingAgent is true while updating an agent", async () => {
    let resolveUpdate!: (v: unknown) => void;
    (client.updateAgent as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveUpdate = r; }),
    );

    const { result } = renderHook(() => useAgents(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let updatePromise: Promise<unknown>;
    act(() => {
      updatePromise = result.current.updateAgent("agent-1", { role: "designer" });
    });

    expect(result.current.isUpdatingAgent).toBe(true);

    await act(async () => {
      resolveUpdate(fakeAgent({ name: "agent-1", role: "designer" }));
      await updatePromise;
    });

    expect(result.current.isUpdatingAgent).toBe(false);
  });

  it("isAddingTeam is true while adding a team", async () => {
    let resolveAdd!: (v: unknown) => void;
    (client.addTeam as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveAdd = r; }),
    );

    const { result } = renderHook(() => useAgents(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let addPromise: Promise<unknown>;
    act(() => {
      addPromise = result.current.addTeam({ name: "team-2" });
    });

    expect(result.current.isAddingTeam).toBe(true);

    await act(async () => {
      resolveAdd({ added: true });
      await addPromise;
    });

    expect(result.current.isAddingTeam).toBe(false);
  });

  it("isRemovingTeam is true while removing a team", async () => {
    let resolveRemove!: (v: unknown) => void;
    (client.removeTeam as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveRemove = r; }),
    );

    const { result } = renderHook(() => useAgents(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let removePromise: Promise<unknown>;
    act(() => {
      removePromise = result.current.removeTeam("team-1");
    });

    expect(result.current.isRemovingTeam).toBe(true);

    await act(async () => {
      resolveRemove({ removed: true });
      await removePromise;
    });

    expect(result.current.isRemovingTeam).toBe(false);
  });

  it("isRenamingTeam is true while renaming a team", async () => {
    let resolveRename!: (v: unknown) => void;
    (client.renameTeam as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveRename = r; }),
    );

    const { result } = renderHook(() => useAgents(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let renamePromise: Promise<unknown>;
    act(() => {
      renamePromise = result.current.renameTeam("team-1", "team-renamed");
    });

    expect(result.current.isRenamingTeam).toBe(true);

    await act(async () => {
      resolveRename(fakeTeam({ name: "team-renamed" }));
      await renamePromise;
    });

    expect(result.current.isRenamingTeam).toBe(false);
  });

  it("refetch re-fetches agents and teams", async () => {
    const { result } = renderHook(() => useAgents(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const newAgents = [fakeAgent({ name: "agent-3" })];
    const newTeams = [fakeTeam({ name: "team-2", agents: newAgents })];
    (client.getAgents as ReturnType<typeof vi.fn>).mockResolvedValue(newAgents);
    (client.getTeams as ReturnType<typeof vi.fn>).mockResolvedValue(newTeams);

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.agents).toHaveLength(1);
    expect(result.current.agents[0].name).toBe("agent-3");
    expect(result.current.teams).toHaveLength(1);
    expect(result.current.teams[0].name).toBe("team-2");
  });

  it("error is set when fetch fails", async () => {
    const fetchError = new Error("network error");
    client = createMockClient({
      getAgents: vi.fn().mockRejectedValue(fetchError),
      getTeams: vi.fn().mockResolvedValue([]),
    });
    wrapper = createWrapper(client, store);

    const { result } = renderHook(() => useAgents(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe(fetchError);
  });
});
