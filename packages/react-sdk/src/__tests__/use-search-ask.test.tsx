import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { PolpoClient, type SearchAskEvent, type SearchAskOptions } from "@polpo-ai/sdk";
import { useSearchAsk } from "../hooks/use-search-ask.js";
import { createMockClient, createMockStore, createWrapper } from "./helpers.js";

const RESULT = {
  answer: "Un task è fallito.",
  items: [{ type: "task", id: "t1", title: "Invoice run", url: "/tasks/t1", score: 1 }],
  intents: [{ kind: "navigate", route: "/tasks/t1", label: "Invoice run", auto: true }],
  fastPath: false,
  rounds: 2,
} as const;

describe("useSearchAsk", () => {
  it("streams the answer, the results and the intents, then the result", async () => {
    let release: () => void = () => {};
    const searchAsk = vi.fn((_q: string, opts: SearchAskOptions) => new Promise((resolve) => {
      opts.onEvent!({ type: "status", text: "Searching “invoice”…" });
      opts.onEvent!({ type: "delta", text: "Un task " });
      opts.onEvent!({ type: "delta", text: "è fallito." });
      opts.onEvent!({ type: "results", items: RESULT.items as never });
      opts.onEvent!({ type: "intent", intent: RESULT.intents[0] as never });
      release = () => resolve(RESULT);
    }));
    const client = createMockClient({ searchAsk });
    const { result } = renderHook(() => useSearchAsk(), { wrapper: createWrapper(client, createMockStore()) });

    let pending: Promise<unknown> = Promise.resolve();
    act(() => { pending = result.current.ask("quali task sono falliti?", { route: "/dashboard" }); });
    await waitFor(() => expect(result.current.answer).toBe("Un task è fallito."));
    expect(result.current.status).toBe("asking");
    expect(result.current.items).toHaveLength(1);
    expect(result.current.intents[0]).toMatchObject({ kind: "navigate", auto: true });
    expect(searchAsk).toHaveBeenCalledWith("quali task sono falliti?", expect.objectContaining({ route: "/dashboard", signal: expect.any(AbortSignal) }));

    await act(async () => { release(); await pending; });
    expect(result.current.status).toBe("done");
    expect(result.current.result).toEqual(RESULT);
  });

  it("an error is kept with its code; a newer question cancels the older one", async () => {
    const searchAsk = vi.fn()
      .mockImplementationOnce((_q: string, opts: SearchAskOptions) => new Promise((_, reject) => opts.signal!.addEventListener("abort", () => reject(new Error("aborted")))))
      .mockRejectedValueOnce(Object.assign(new Error("not configured"), { code: "NO_MODEL" }));
    const client = createMockClient({ searchAsk });
    const { result } = renderHook(() => useSearchAsk(), { wrapper: createWrapper(client, createMockStore()) });
    let first: Promise<unknown> = Promise.resolve();
    act(() => { first = result.current.ask("one"); });
    await act(async () => { await result.current.ask("two"); });
    expect(await first).toBeNull();
    expect(result.current.status).toBe("error");
    expect(result.current.question).toBe("two");
    expect(result.current.error?.code).toBe("NO_MODEL");
  });
});

describe("PolpoClient.searchAsk", () => {
  it("parses the Server-Sent Events and returns the done result", async () => {
    const events: SearchAskEvent[] = [{ type: "delta", text: "Ciao" }, { type: "done", result: RESULT as never }];
    const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({ q: "ciao", stream: true, route: "/x" });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const client = new PolpoClient({ baseUrl: "http://localhost:3000", fetch: fetchFn as never });
    const seen: string[] = [];
    const out = await client.searchAsk("ciao", { route: "/x", onEvent: (e) => seen.push(e.type) });
    expect(seen).toEqual(["delta", "done"]);
    expect(out.answer).toBe(RESULT.answer);
  });

  it("an error event or a JSON error throws with its code", async () => {
    const sse = new PolpoClient({ baseUrl: "http://localhost:3000", fetch: (async () => new Response(`data: ${JSON.stringify({ type: "error", error: "slow", code: "TIMEOUT" })}\n\n`, { headers: { "content-type": "text/event-stream" } })) as never });
    await expect(sse.searchAsk("x", { onEvent: () => {} })).rejects.toMatchObject({ code: "TIMEOUT" });
    const json = new PolpoClient({ baseUrl: "http://localhost:3000", fetch: (async () => new Response(JSON.stringify({ ok: false, error: "no model", code: "NO_MODEL" }), { status: 503, headers: { "content-type": "application/json" } })) as never });
    await expect(json.searchAsk("x")).rejects.toMatchObject({ code: "NO_MODEL" });
  });
});
