import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTasks } from "../hooks/use-tasks.js";
import {
  createMockClient,
  createMockStore,
  createWrapper,
  fakeTask,
} from "./helpers.js";
import type { PolpoClient } from "@polpo-ai/sdk";
import type { PolpoStore } from "@polpo-ai/sdk";

describe("useTasks", () => {
  let client: PolpoClient;
  let store: PolpoStore;
  let wrapper: React.ComponentType<{ children: React.ReactNode }>;

  beforeEach(() => {
    const tasks = [
      fakeTask({ id: "t1", title: "Task 1" }),
      fakeTask({ id: "t2", title: "Task 2" }),
    ];
    client = createMockClient({
      getTasks: vi.fn().mockResolvedValue(tasks),
    });
    store = createMockStore();
    wrapper = createWrapper(client, store);
  });

  it("returns tasks from the store after fetch", async () => {
    const { result } = renderHook(() => useTasks(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.tasks).toHaveLength(2);
    expect(result.current.tasks[0].id).toBe("t1");
    expect(result.current.error).toBe(null);
  });

  it("isLoading starts true, becomes false after fetch", async () => {
    const { result } = renderHook(() => useTasks(), { wrapper });

    // Initially loading
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
  });

  it("createTask sets isCreating to true while pending", async () => {
    let resolveCreate!: (task: ReturnType<typeof fakeTask>) => void;
    (client.createTask as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveCreate = r; }),
    );

    const { result } = renderHook(() => useTasks(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let createPromise: Promise<unknown>;
    act(() => {
      createPromise = result.current.createTask({ title: "New", description: "desc" });
    });

    expect(result.current.isCreating).toBe(true);

    const newTask = fakeTask({ id: "t3", title: "New" });
    await act(async () => {
      resolveCreate(newTask);
      await createPromise;
    });

    expect(result.current.isCreating).toBe(false);
  });

  it("deleteTask sets isDeleting to true while pending", async () => {
    let resolveDelete!: (v: unknown) => void;
    (client.deleteTask as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveDelete = r; }),
    );

    const { result } = renderHook(() => useTasks(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let deletePromise: Promise<unknown>;
    act(() => {
      deletePromise = result.current.deleteTask("t1");
    });

    expect(result.current.isDeleting).toBe(true);

    await act(async () => {
      resolveDelete({ removed: true });
      await deletePromise;
    });

    expect(result.current.isDeleting).toBe(false);
  });

  it("retryTask sets isRetrying to true while pending", async () => {
    let resolveRetry!: (v: unknown) => void;
    (client.retryTask as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveRetry = r; }),
    );

    const { result } = renderHook(() => useTasks(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let retryPromise: Promise<unknown>;
    act(() => {
      retryPromise = result.current.retryTask("t1");
    });

    expect(result.current.isRetrying).toBe(true);

    await act(async () => {
      resolveRetry({ retried: true });
      await retryPromise;
    });

    expect(result.current.isRetrying).toBe(false);
  });

  it("refetch re-fetches data", async () => {
    const { result } = renderHook(() => useTasks(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Update mock to return new data
    const newTasks = [fakeTask({ id: "t3", title: "Task 3" })];
    (client.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue(newTasks);

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0].id).toBe("t3");
  });

  it("invalidate is an alias for refetch", async () => {
    const { result } = renderHook(() => useTasks(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const newTasks = [fakeTask({ id: "t4", title: "Task 4" })];
    (client.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue(newTasks);

    await act(async () => {
      await result.current.invalidate();
    });

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0].id).toBe("t4");
  });

  it("error is set when fetch fails", async () => {
    const fetchError = new Error("network error");
    client = createMockClient({
      getTasks: vi.fn().mockRejectedValue(fetchError),
    });
    wrapper = createWrapper(client, store);

    const { result } = renderHook(() => useTasks(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe(fetchError);
  });
});
