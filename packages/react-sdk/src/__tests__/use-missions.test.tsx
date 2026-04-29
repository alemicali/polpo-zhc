import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useMissions } from "../hooks/use-missions.js";
import {
  createMockClient,
  createMockStore,
  createWrapper,
  fakeMission,
} from "./helpers.js";
import type { PolpoClient } from "@polpo-ai/sdk";
import type { PolpoStore } from "@polpo-ai/sdk";

describe("useMissions", () => {
  let client: PolpoClient;
  let store: PolpoStore;
  let wrapper: React.ComponentType<{ children: React.ReactNode }>;

  beforeEach(() => {
    const missions = [
      fakeMission({ id: "m1", name: "Mission 1" }),
      fakeMission({ id: "m2", name: "Mission 2" }),
    ];
    client = createMockClient({
      getMissions: vi.fn().mockResolvedValue(missions),
    });
    store = createMockStore();
    wrapper = createWrapper(client, store);
  });

  it("returns missions from the store after fetch", async () => {
    const { result } = renderHook(() => useMissions(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.missions).toHaveLength(2);
    expect(result.current.missions[0].id).toBe("m1");
    expect(result.current.error).toBe(null);
  });

  it("isLoading starts true, becomes false after fetch", async () => {
    const { result } = renderHook(() => useMissions(), { wrapper });

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
  });

  it("isCreating is true while creating a mission", async () => {
    let resolveCreate!: (mission: ReturnType<typeof fakeMission>) => void;
    (client.createMission as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveCreate = r; }),
    );

    const { result } = renderHook(() => useMissions(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let createPromise: Promise<unknown>;
    act(() => {
      createPromise = result.current.createMission({ name: "New Mission", data: "{}" });
    });

    expect(result.current.isCreating).toBe(true);

    const newMission = fakeMission({ id: "m3", name: "New Mission" });
    await act(async () => {
      resolveCreate(newMission);
      await createPromise;
    });

    expect(result.current.isCreating).toBe(false);
  });

  it("isExecuting is true while executing a mission", async () => {
    let resolveExecute!: (v: unknown) => void;
    (client.executeMission as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveExecute = r; }),
    );

    const { result } = renderHook(() => useMissions(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let executePromise: Promise<unknown>;
    act(() => {
      executePromise = result.current.executeMission("m1");
    });

    expect(result.current.isExecuting).toBe(true);

    await act(async () => {
      resolveExecute({ missionId: "m1", taskCount: 3 });
      await executePromise;
    });

    expect(result.current.isExecuting).toBe(false);
  });

  it("isUpdating is true while updating a mission", async () => {
    let resolveUpdate!: (v: unknown) => void;
    (client.updateMission as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveUpdate = r; }),
    );

    const { result } = renderHook(() => useMissions(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let updatePromise: Promise<unknown>;
    act(() => {
      updatePromise = result.current.updateMission("m1", { name: "Updated" });
    });

    expect(result.current.isUpdating).toBe(true);

    await act(async () => {
      resolveUpdate(fakeMission({ id: "m1", name: "Updated" }));
      await updatePromise;
    });

    expect(result.current.isUpdating).toBe(false);
  });

  it("isDeleting is true while deleting a mission", async () => {
    let resolveDelete!: (v: unknown) => void;
    (client.deleteMission as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveDelete = r; }),
    );

    const { result } = renderHook(() => useMissions(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let deletePromise: Promise<unknown>;
    act(() => {
      deletePromise = result.current.deleteMission("m1");
    });

    expect(result.current.isDeleting).toBe(true);

    await act(async () => {
      resolveDelete({ deleted: true });
      await deletePromise;
    });

    expect(result.current.isDeleting).toBe(false);
  });

  it("isResuming is true while resuming a mission", async () => {
    let resolveResume!: (v: unknown) => void;
    (client.resumeMission as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveResume = r; }),
    );

    const { result } = renderHook(() => useMissions(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let resumePromise: Promise<unknown>;
    act(() => {
      resumePromise = result.current.resumeMission("m1");
    });

    expect(result.current.isResuming).toBe(true);

    await act(async () => {
      resolveResume({ missionId: "m1", resumed: true });
      await resumePromise;
    });

    expect(result.current.isResuming).toBe(false);
  });

  it("isAborting is true while aborting a mission", async () => {
    let resolveAbort!: (v: unknown) => void;
    (client.abortMission as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveAbort = r; }),
    );

    const { result } = renderHook(() => useMissions(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let abortPromise: Promise<unknown>;
    act(() => {
      abortPromise = result.current.abortMission("m1");
    });

    expect(result.current.isAborting).toBe(true);

    await act(async () => {
      resolveAbort({ aborted: 1 });
      await abortPromise;
    });

    expect(result.current.isAborting).toBe(false);
  });

  it("invalidate re-fetches missions", async () => {
    const { result } = renderHook(() => useMissions(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const newMissions = [fakeMission({ id: "m3", name: "Mission 3" })];
    (client.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue(newMissions);

    await act(async () => {
      await result.current.invalidate();
    });

    expect(result.current.missions).toHaveLength(1);
    expect(result.current.missions[0].id).toBe("m3");
  });

  it("error is set when fetch fails", async () => {
    const fetchError = new Error("network error");
    client = createMockClient({
      getMissions: vi.fn().mockRejectedValue(fetchError),
    });
    wrapper = createWrapper(client, store);

    const { result } = renderHook(() => useMissions(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe(fetchError);
  });
});
