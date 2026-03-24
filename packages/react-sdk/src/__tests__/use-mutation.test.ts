import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMutation } from "../hooks/use-mutation.js";

describe("useMutation", () => {
  it("isPending starts false", () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const { result } = renderHook(() => useMutation(fn));

    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBe(null);
  });

  it("isPending becomes true during mutation and returns to false", async () => {
    let resolve!: (value: string) => void;
    const fn = vi.fn().mockImplementation(
      () => new Promise<string>((r) => { resolve = r; }),
    );

    const { result } = renderHook(() => useMutation(fn));

    let mutatePromise: Promise<string>;
    act(() => {
      mutatePromise = result.current.mutate();
    });

    // isPending should be true while the promise is unresolved
    expect(result.current.isPending).toBe(true);

    await act(async () => {
      resolve("done");
      await mutatePromise;
    });

    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBe(null);
  });

  it("error is set on failure", async () => {
    const error = new Error("boom");
    const fn = vi.fn().mockRejectedValue(error);

    const { result } = renderHook(() => useMutation(fn));

    await act(async () => {
      await result.current.mutate().catch(() => {});
    });

    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBe(error);
  });

  it("successful mutation returns result", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const { result } = renderHook(() => useMutation(fn));

    let returnedValue: number | undefined;
    await act(async () => {
      returnedValue = await result.current.mutate();
    });

    expect(returnedValue).toBe(42);
  });

  it("onSuccess callback is called on success", async () => {
    const onSuccess = vi.fn();
    const fn = vi.fn().mockResolvedValue("result");

    const { result } = renderHook(() => useMutation(fn, { onSuccess }));

    await act(async () => {
      await result.current.mutate();
    });

    expect(onSuccess).toHaveBeenCalledWith("result");
  });

  it("onSuccess callback is NOT called on failure", async () => {
    const onSuccess = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    const { result } = renderHook(() => useMutation(fn, { onSuccess }));

    await act(async () => {
      await result.current.mutate().catch(() => {});
    });

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("error is cleared on a new successful mutation", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("first fail"))
      .mockResolvedValueOnce("ok");

    const { result } = renderHook(() => useMutation(fn));

    // First call — fails
    await act(async () => {
      await result.current.mutate().catch(() => {});
    });
    expect(result.current.error).not.toBe(null);

    // Second call — succeeds, error should be cleared
    await act(async () => {
      await result.current.mutate();
    });
    expect(result.current.error).toBe(null);
  });
});
