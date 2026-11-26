import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MediaLogEntry, MediaResult, MediaStatus } from "@polpo-ai/react";

// ── SDK mock: the media hooks and the client behind them ──
const state = vi.hoisted(() => ({
  status: undefined as unknown as MediaStatus,
  entries: [] as MediaLogEntry[],
  calls: [] as Array<{ fn: string; args: unknown[] }>,
  result: null as MediaResult | null,
  config: { settings: {} as Record<string, unknown> },
}));

vi.mock("@polpo-ai/react", async () => {
  const React = await import("react");
  const imageUrl = (id: string, i: number, o?: { thumb?: boolean; download?: boolean }) => `/api/v1/media/images/${id}/${i}${o?.thumb ? "?thumb=1" : o?.download ? "?download=1" : ""}`;
  const client = {
    getConfig: async () => state.config,
    getMediaStatus: async () => state.status,
    updateSettings: async (patch: unknown) => { state.calls.push({ fn: "updateSettings", args: [patch] }); return state.config; },
  };
  return {
    usePolpo: () => ({ client }),
    useEvents: () => ({ events: [] }),
    useGenerateImage: () => {
      const [result, setResult] = React.useState<MediaResult | null>(null);
      return {
        generate: async (req: unknown) => { state.calls.push({ fn: "generate", args: [req] }); setResult(state.result); return state.result; },
        edit: async () => state.result, result, isGenerating: false, error: null, reset: () => setResult(null), imageUrl,
      };
    },
    useMediaLog: () => ({ page: { entries: state.entries, total: state.entries.length }, status: state.status, isLoading: false, error: null, refetch: async () => {} }),
  };
});

vi.mock("@/hooks/use-vault-catalog", () => ({
  useVaultCatalog: () => ({ entries: [{ owner: "polpo-infra", service: "vercel-ai-gateway", type: "api_key", keys: ["token"], allowedAgents: [] }], error: null, loading: false, reload: () => {} }),
}));

import { MemoryRouter } from "react-router-dom";
import { MediaPage } from "../src/pages/media";
import { MediaSection } from "../src/components/config/media-section";
import { mediaCallerText, mediaFormFrom, mediaPatchFrom, splitImageModel } from "../src/lib/media";

const STATUS: MediaStatus = {
  configured: true, model: "vercel-ai-gateway:openai/gpt-image-2", gateway: { id: "vercel-ai-gateway", label: "Vercel AI Gateway" }, fallbackModel: "vercel-ai-gateway:bfl/flux-2-pro",
  key: { ok: true, source: "vault", detail: "vault polpo-infra / vercel-ai-gateway (token)" }, maxImages: 4, retention: 1000, retentionDays: 90, analysis: "chat",
  gateways: [{ id: "vercel-ai-gateway", label: "Vercel AI Gateway", envVar: "AI_GATEWAY_API_KEY" }],
};
const ASSET = { index: 0, path: "media/images/img_aaaaaa111111/0.png", mimeType: "image/png", bytes: 2048, width: 1024, height: 1024, sha256: "ab".repeat(32) };
const RESULT: MediaResult = {
  id: "img_aaaaaa111111", kind: "generate", model: "vercel-ai-gateway:openai/gpt-image-2", usedFallback: false, costUsd: 0.042, latencyMs: 9000, warnings: [],
  images: [{ ...ASSET, file: "/p/.polpo/media/images/img_aaaaaa111111/0.png", url: "/api/v1/media/images/img_aaaaaa111111/0" }],
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.status = STATUS;
  state.result = RESULT;
  state.entries = [{
    id: "img_bbbbbb222222", at: "2026-11-26T10:00:00Z", kind: "generate", caller: { kind: "agent", id: "designer", taskId: "t1" }, status: "ok",
    model: "vercel-ai-gateway:openai/gpt-image-2", prompt: "A fox in the snow", size: "1024x1024", n: 1, seed: 7, latencyMs: 8000, costUsd: 0.04, usage: {},
    assets: [{ ...ASSET, path: "media/images/img_bbbbbb222222/0.png" }],
  }];
  state.calls = [];
  state.config = { settings: {} };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const buttons = (text: string) => [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text);
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const pick = async (el: HTMLSelectElement, value: string) => {
  await act(async () => { el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); });
};

describe("the Media page", () => {
  const render = async (path = "/media") => {
    await act(async () => root.render(<MemoryRouter initialEntries={[path]}><MediaPage /></MemoryRouter>));
    await flush();
  };

  test("status, try a prompt with size, variants and seed, the result's images", async () => {
    await render();
    expect($('[data-testid="media-status"]')!.textContent).toContain("vercel-ai-gateway:openai/gpt-image-2");
    expect($('[data-testid="media-status"]')!.textContent).toContain("fallback vercel-ai-gateway:bfl/flux-2-pro");
    await type($<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!, "A lighthouse at dawn");
    await pick($<HTMLSelectElement>('select[aria-label="Size"]')!, "1536x1024");
    await pick($<HTMLSelectElement>('select[aria-label="Variants"]')!, "2");
    await type($<HTMLInputElement>('input[aria-label="Seed"]')!, "7");
    await click(buttons("Generate")[0]!);
    expect(state.calls.find((c) => c.fn === "generate")!.args[0]).toEqual({ prompt: "A lighthouse at dawn", size: "1536x1024", n: 2, seed: 7 });
    const result = $('[data-testid="media-result"]')!;
    expect(result.textContent).toContain("$0.0420");
    expect(result.querySelector("img")!.getAttribute("src")).toBe("/api/v1/media/images/img_aaaaaa111111/0");
  });

  test("history: a row with its preview and who asked; it opens with the provenance", async () => {
    await render();
    const row = $('[data-entry="img_bbbbbb222222"]')!;
    expect(row.querySelector("img")!.getAttribute("src")).toBe("/api/v1/media/images/img_bbbbbb222222/0?thumb=1");
    expect(row.textContent).toContain("agent · designer · task t1");
    await click(row.querySelector("button")!);
    const detail = $('[data-testid="media-detail"]')!;
    expect(detail.textContent).toContain("A fox in the snow");
    expect(detail.textContent).toContain("Seed7");
    expect(detail.textContent).toContain(".polpo/media/images/img_bbbbbb222222/0.png");
    expect(detail.querySelector('a[href$="?download=1"]')).toBeTruthy();
  });

  test("not configured: the playground points to Settings", async () => {
    state.status = { ...STATUS, configured: false, model: undefined, key: undefined, fallbackModel: undefined };
    state.entries = [];
    await render();
    expect($('[data-testid="media-status"]')!.textContent).toContain("No image model is configured");
    expect($('[data-testid="media-playground"] a[href="/config?section=media"]')).toBeTruthy();
    expect($('[data-testid="media-empty"]')).toBeTruthy();
  });
});

describe("Settings → Media", () => {
  test("loads the saved model with its vault entry and saves the form as settings", async () => {
    state.config = { settings: { imageModel: "vercel-ai-gateway:openai/gpt-image-2", media: { credentialRef: { owner: "polpo-infra", service: "vercel-ai-gateway" }, credentialField: "token" } } };
    await act(async () => root.render(<MemoryRouter><MediaSection /></MemoryRouter>));
    await flush();
    expect($<HTMLInputElement>('input[aria-label="Image model"]')!.value).toBe("openai/gpt-image-2");
    expect($('[data-testid="media-key-status"]')!.textContent).toContain("key from vault polpo-infra / vercel-ai-gateway (token)");
    await type($<HTMLInputElement>('input[aria-label="Fallback model"]')!, "bfl/flux-2-pro");
    await type($<HTMLInputElement>('input[aria-label="Requests kept"]')!, "200");
    await click(buttons("Save")[0]!);
    expect(state.calls.find((c) => c.fn === "updateSettings")!.args[0]).toEqual({
      imageModel: "vercel-ai-gateway:openai/gpt-image-2",
      media: { fallbackModel: "vercel-ai-gateway:bfl/flux-2-pro", credentialRef: { owner: "polpo-infra", service: "vercel-ai-gateway" }, credentialField: "token", retention: 200 },
    });
  });

  test("the form helpers: a bare provider/model, an empty model removes it, who asked", () => {
    expect(splitImageModel("bfl/flux-2-pro")).toEqual({ gateway: "vercel-ai-gateway", model: "bfl/flux-2-pro" });
    expect(mediaPatchFrom(mediaFormFrom(undefined, { retentionDays: 0 }))).toEqual({ imageModel: null, media: { retentionDays: 0 } });
    expect(mediaCallerText({ caller: { kind: "mission", id: "m1", missionId: "m1", label: "post → cover" } })).toBe("mission · m1");
  });
});
