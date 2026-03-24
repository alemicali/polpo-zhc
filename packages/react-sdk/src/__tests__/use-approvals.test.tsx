import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useApprovals } from "../hooks/use-approvals.js";
import {
  createMockClient,
  createMockStore,
  createWrapper,
  fakeApproval,
} from "./helpers.js";
import type { PolpoClient } from "@polpo-ai/sdk";
import type { PolpoStore } from "@polpo-ai/sdk";

describe("useApprovals", () => {
  let client: PolpoClient;
  let store: PolpoStore;
  let wrapper: React.ComponentType<{ children: React.ReactNode }>;

  beforeEach(() => {
    const approvals = [
      fakeApproval({ id: "a1", status: "pending" }),
      fakeApproval({ id: "a2", status: "approved" }),
      fakeApproval({ id: "a3", status: "pending" }),
    ];
    client = createMockClient({
      getApprovals: vi.fn().mockResolvedValue(approvals),
    });
    store = createMockStore();
    wrapper = createWrapper(client, store);
  });

  it("returns approvals and pending filtered list", async () => {
    const { result } = renderHook(() => useApprovals(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.approvals).toHaveLength(3);
    expect(result.current.pending).toHaveLength(2);
    expect(result.current.pending.every((a) => a.status === "pending")).toBe(true);
  });

  it("isLoading starts true, becomes false after fetch", async () => {
    const { result } = renderHook(() => useApprovals(), { wrapper });

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
  });

  it("loading is an alias for isLoading", async () => {
    const { result } = renderHook(() => useApprovals(), { wrapper });

    // Both should be in sync
    expect(result.current.loading).toBe(result.current.isLoading);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.loading).toBe(false);
  });

  it("isApproving is true while approving a request", async () => {
    let resolveApprove!: (v: unknown) => void;
    (client.approveRequest as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveApprove = r; }),
    );

    const { result } = renderHook(() => useApprovals(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let approvePromise: Promise<unknown>;
    act(() => {
      approvePromise = result.current.approve("a1");
    });

    expect(result.current.isApproving).toBe(true);

    await act(async () => {
      resolveApprove(fakeApproval({ id: "a1", status: "approved" }));
      await approvePromise;
    });

    expect(result.current.isApproving).toBe(false);
  });

  it("isRejecting is true while rejecting a request", async () => {
    let resolveReject!: (v: unknown) => void;
    (client.rejectRequest as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveReject = r; }),
    );

    const { result } = renderHook(() => useApprovals(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let rejectPromise: Promise<unknown>;
    act(() => {
      rejectPromise = result.current.reject("a1", "Not good enough");
    });

    expect(result.current.isRejecting).toBe(true);

    await act(async () => {
      resolveReject(fakeApproval({ id: "a1", status: "rejected" }));
      await rejectPromise;
    });

    expect(result.current.isRejecting).toBe(false);
  });

  it("refetch triggers a new fetch", async () => {
    const { result } = renderHook(() => useApprovals(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Update mock to return different data
    const newApprovals = [fakeApproval({ id: "a4", status: "pending" })];
    (client.getApprovals as ReturnType<typeof vi.fn>).mockResolvedValue(newApprovals);

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.approvals).toHaveLength(1);
    });

    expect(result.current.approvals[0].id).toBe("a4");
    expect(result.current.pending).toHaveLength(1);
  });

  it("approve calls client.approveRequest with correct args", async () => {
    const { result } = renderHook(() => useApprovals(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.approve("a1", { resolvedBy: "admin", note: "LGTM" });
    });

    expect(client.approveRequest).toHaveBeenCalledWith("a1", {
      resolvedBy: "admin",
      note: "LGTM",
    });
  });

  it("reject calls client.rejectRequest with correct args", async () => {
    const { result } = renderHook(() => useApprovals(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.reject("a1", "Needs improvement", "reviewer");
    });

    expect(client.rejectRequest).toHaveBeenCalledWith("a1", "Needs improvement", "reviewer");
  });

  it("returns empty arrays when no approvals exist", async () => {
    client = createMockClient({
      getApprovals: vi.fn().mockResolvedValue([]),
    });
    wrapper = createWrapper(client, store);

    const { result } = renderHook(() => useApprovals(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.approvals).toHaveLength(0);
    expect(result.current.pending).toHaveLength(0);
  });
});
