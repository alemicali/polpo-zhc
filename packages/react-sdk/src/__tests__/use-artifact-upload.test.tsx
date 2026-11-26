import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useArtifactUpload } from "../hooks/use-artifact-upload.js";
import { createMockClient, createMockStore, createWrapper } from "./helpers.js";

const artifact = { id: "art_1", title: "Report", type: "doc", version: 1, size: 10 };

describe("useArtifactUpload", () => {
  it("uploads a small file in one request and a large one in parts with progress, then finalizes", async () => {
    let received = 0;
    const uploadArtifact = vi.fn(async () => artifact);
    const uploadArtifactPart = vi.fn(async (part: Blob, opts: { appendTo?: string; more?: boolean }) => {
      received += part.size;
      return { uploadId: opts.appendTo ?? "upl_aaaaaaaaaaaa", size: received, complete: !opts.more };
    });
    const finalizeArtifactUpload = vi.fn(async () => ({ ...artifact, id: "art_2" }));
    const client = createMockClient({ uploadArtifact, uploadArtifactPart, finalizeArtifactUpload });
    const { result } = renderHook(() => useArtifactUpload({ partBytes: 4 }), { wrapper: createWrapper(client, createMockStore()) });

    await act(async () => { await result.current.upload(new File(["# a"], "a.md")); });
    expect(uploadArtifact).toHaveBeenCalledWith(expect.any(File), { filename: "a.md" });
    expect(result.current.result).toMatchObject({ id: "art_1" });

    await act(async () => { await result.current.upload(new File(["0123456789"], "big.md"), { title: "Big" }); });
    expect(uploadArtifactPart.mock.calls.map(([part, opts]) => [part.size, opts])).toEqual([
      [4, { more: true, filename: "big.md" }],
      [4, { appendTo: "upl_aaaaaaaaaaaa", more: true, filename: "big.md" }],
      [2, { appendTo: "upl_aaaaaaaaaaaa", more: false, filename: "big.md" }],
    ]);
    expect(finalizeArtifactUpload).toHaveBeenCalledWith("upl_aaaaaaaaaaaa", { title: "Big", filename: "big.md" });
    expect(result.current.progress).toEqual({ sent: 10, total: 10 });
    expect(result.current.result).toMatchObject({ id: "art_2" });
  });

  it("replaces a content with expectedVersion and keeps the error", async () => {
    const replaceArtifactContent = vi.fn().mockRejectedValueOnce(new Error("This artifact changed while you were editing it."));
    const client = createMockClient({ replaceArtifactContent });
    const { result } = renderHook(() => useArtifactUpload(), { wrapper: createWrapper(client, createMockStore()) });
    await act(async () => { await result.current.replace("art_1", new File(["x"], "x.md"), { expectedVersion: 3 }).catch(() => {}); });
    expect(replaceArtifactContent).toHaveBeenCalledWith("art_1", expect.any(File), { expectedVersion: 3, filename: "x.md" });
    expect(result.current.error?.message).toMatch(/changed/);
    expect(result.current.isUploading).toBe(false);
  });
});
