import { describe, expect, it } from "vitest";
import { createFillerPicker, fillerKindForTool, VOICE_FILLERS, voiceSseFromCompletion, voiceSseFromText } from "../notifications/voice-stream.js";

const enc = new TextEncoder();

function streamOf(parts: string[], failAfter?: Error): ReadableStream<Uint8Array> {
  // pull-based: every part is delivered before the failure (controller.error() would drop queued parts)
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < parts.length) controller.enqueue(enc.encode(parts[i++]));
      else if (failAfter) controller.error(failAfter);
      else controller.close();
    },
  });
}

async function events(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const text = await new Response(stream).text();
  return text.split("\n\n").filter(Boolean).map((block) => {
    expect(block.startsWith("data: ")).toBe(true);
    return block.slice("data: ".length);
  });
}

async function chunks(stream: ReadableStream<Uint8Array>) {
  const raw = await events(stream);
  expect(raw[raw.length - 1]).toBe("[DONE]");
  return raw.slice(0, -1).map((e) => JSON.parse(e));
}

function contentOf(parsed: any[]): string {
  return parsed.map((c) => c.choices[0].delta.content ?? "").join("");
}

const up = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: "u", object: "chat.completion.chunk", created: 1, model: "polpo", choices: [{ index: 0, delta, finish_reason: null, ...extra }] })}\n\n`;

describe("voiceSseFromText", () => {
  it("is a valid OpenAI stream: role first, the text, then stop and [DONE]", async () => {
    const parsed = await chunks(voiceSseFromText("Ciao, sono Polpo.", "voice-1"));
    expect(parsed[0].choices[0].delta.role).toBe("assistant");
    expect(contentOf(parsed)).toBe("Ciao, sono Polpo.");
    const last = parsed[parsed.length - 1];
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(parsed.every((c) => c.id === "voice-1" && c.object === "chat.completion.chunk")).toBe(true);
  });
});

describe("voiceSseFromCompletion", () => {
  it("keeps only the spoken content: thinking, tool calls and extra fields never reach the voice", async () => {
    const parsed = await chunks(voiceSseFromCompletion(streamOf([
      up({ role: "assistant" }),
      up({}, { thinking: "let me check the volume" }),
      up({ content: "Un attimo, " }),
      up({}, { tool_call: { id: "t1", name: "get_device_status", state: "preparing" } }),
      up({}, { tool_call: { id: "t1", name: "get_device_status", state: "completed", result: "{}" } }),
      up({ content: "volume a 60." }),
      up({}, {}).replace('"finish_reason":null', '"finish_reason":"stop"'),
      "data: [DONE]\n\n",
    ]), "voice-2"));
    expect(contentOf(parsed)).toBe("Un attimo... volume a 60.");
    for (const c of parsed) {
      expect(Object.keys(c.choices[0]).sort()).toEqual(["delta", "finish_reason", "index"]);
      expect(Object.keys(c.choices[0].delta).every((k) => k === "role" || k === "content")).toBe(true);
    }
    expect(parsed.filter((c) => c.choices[0].finish_reason === "stop")).toHaveLength(1);
  });

  it("reassembles events split anywhere across network chunks, including multi-byte characters", async () => {
    const whole = up({ content: "È così, perché sì 🐙" }) + up({ content: " ok" }) + "data: [DONE]\n\n";
    const bytes = enc.encode(whole);
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) pieces.push(bytes.slice(i, i + 7));
    const stream = new ReadableStream<Uint8Array>({
      start(c) { for (const p of pieces) c.enqueue(p); c.close(); },
    });
    expect(contentOf(await chunks(voiceSseFromCompletion(stream, "v")))).toBe("È così, perché sì 🐙 ok");
  });

  it("ends properly even when the upstream never sends [DONE]", async () => {
    const parsed = await chunks(voiceSseFromCompletion(streamOf([up({ content: "fine" })]), "v"));
    expect(contentOf(parsed)).toBe("fine");
    expect(parsed[parsed.length - 1].choices[0].finish_reason).toBe("stop");
  });

  it("speaks a short apology when the turn fails before saying anything", async () => {
    const parsed = await chunks(voiceSseFromCompletion(
      streamOf([`data: ${JSON.stringify({ error: { message: "model down" } })}\n\n`]), "v", { errorText: "Scusa, ho un problema." }));
    expect(contentOf(parsed)).toBe("Scusa, ho un problema.");
  });

  it("never speaks Polpo's inline model error (marked error: true), apologises instead", async () => {
    const parsed = await chunks(voiceSseFromCompletion(streamOf([
      up({ role: "assistant" }),
      up({ content: "\n\nError: 403 {\"type\":\"error\"}" }, { error: true }),
      `data: ${JSON.stringify({ error: { message: "403", code: "model_stream_failed" } })}\n\n`,
    ]), "v", { errorText: "Scusa, ho un problema." }));
    expect(contentOf(parsed)).toBe("Scusa, ho un problema.");
  });

  it("stops cleanly, without the error text, when the model fails after speaking", async () => {
    const parsed = await chunks(voiceSseFromCompletion(streamOf([
      up({ content: "Dunque" }),
      up({ content: "\n\nError: boom" }, { error: true }),
    ]), "v", { errorText: "Scusa." }));
    expect(contentOf(parsed)).toBe("Dunque");
  });

  it("does not interrupt a reply already being spoken when the upstream breaks mid-way", async () => {
    const parsed = await chunks(voiceSseFromCompletion(
      streamOf([up({ content: "Allora" })], new Error("socket hang up")), "v", { errorText: "Scusa." }));
    expect(contentOf(parsed)).toBe("Allora");
    expect(parsed[parsed.length - 1].choices[0].finish_reason).toBe("stop");
  });

  it("ignores comments, blank keep-alives, non-JSON lines and events after [DONE]", async () => {
    const parsed = await chunks(voiceSseFromCompletion(streamOf([
      ": keep-alive\n\n", "\n\n", "data: not json\n\n", "event: ping\ndata: {}\n\n",
      up({ content: "ok" }), "data: [DONE]\n\n", up({ content: "dopo la fine" }),
    ]), "v"));
    expect(contentOf(parsed)).toBe("ok");
  });

  it("handles CRLF line endings", async () => {
    const parsed = await chunks(voiceSseFromCompletion(streamOf([up({ content: "uno" }).replace(/\n/g, "\r\n"), "data: [DONE]\r\n\r\n"]), "v"));
    expect(contentOf(parsed)).toBe("uno");
  });

  it("cancels the upstream when the voice client goes away", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(up({ content: "parte" }))); },
      cancel() { cancelled = true; },
    });
    const reader = voiceSseFromCompletion(upstream, "v").getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
  });
});

// ── Courtesy fillers: a person asked a question says "let me look…", "one more second…" ──

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Upstream that waits where told: parts are SSE strings or { wait: ms }. */
function timedStreamOf(parts: (string | { wait: number })[], failAtEnd?: Error): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      while (i < parts.length) {
        const p = parts[i++];
        if (typeof p === "string") { controller.enqueue(enc.encode(p)); return; }
        await sleep(p.wait);
      }
      if (failAtEnd) controller.error(failAtEnd);
      else controller.close();
    },
  });
}

const tool = (name: string, state: string, id = "t1") => up({}, { tool_call: { id, name, state } });
const FAST = { firstWaitMs: 120, toolWaitMs: 60, quietToolWaitMs: 160, stillWorkingMs: 200, maxStill: 2 };
const first = (pool: readonly string[]) => pool[0];

/** Spoken pieces with words in them; pauses ("... ") belong to the piece before. */
function spokenParts(parsed: any[]): string[] {
  const parts: string[] = [];
  for (const c of parsed) {
    const t = c.choices[0].delta.content;
    if (typeof t !== "string" || !t) continue;
    if (/[\p{L}\p{N}]/u.test(t)) parts.push(t);
    else if (parts.length) parts[parts.length - 1] += t;
  }
  return parts.map((t) => t.trim());
}

/** How a filler is spoken: trailing off ("... "), so the voice says it right away. */
const F = (phrase: string) => phrase.replace(/[.!?]+$/, "") + "...";

describe("voiceSseFromCompletion — courtesy fillers", () => {
  it("says it is searching when a search tool keeps the line silent, then the answer", async () => {
    const parsed = await chunks(voiceSseFromCompletion(timedStreamOf([
      tool("search_web", "preparing"), { wait: 150 },
      tool("search_web", "completed"), up({ content: "La Roma ha vinto." }), "data: [DONE]\n\n",
    ]), "v", { language: "it", timing: FAST, pick: first }));
    expect(spokenParts(parsed)).toEqual([F(VOICE_FILLERS.it.search[0]), "La Roma ha vinto."]);
  });

  it("sentences around a filler or a tool stay separate words for the voice", async () => {
    const parsed = await chunks(voiceSseFromCompletion(timedStreamOf([
      tool("search_web", "preparing"), { wait: 120 }, up({ content: "La Roma ha vinto." }),
      tool("http_fetch", "calling", "t2"), up({ content: "Domani piove." }), "data: [DONE]\n\n",
    ]), "v", { language: "it", timing: FAST, pick: first }));
    expect(contentOf(parsed)).toBe(`${F(VOICE_FILLERS.it.search[0])} La Roma ha vinto... Domani piove.`);
  });

  it("closes the agent's announcement as soon as a tool starts, so the voice says it right away", async () => {
    const reader = voiceSseFromCompletion(timedStreamOf([
      up({ content: "Un attimo, controllo." }), tool("search_web", "preparing"), { wait: 400 },
      up({ content: "Fatto." }), "data: [DONE]\n\n",
    ]), "v", { language: "it", timing: { ...FAST, stillWorkingMs: 5000 }, pick: first }).getReader();
    const dec = new TextDecoder();
    const t0 = Date.now();
    let said = "";
    while (!said.endsWith("... ")) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const block of dec.decode(value).split("\n\n")) {
        if (block.startsWith("data: {")) said += JSON.parse(block.slice(6)).choices[0].delta.content ?? "";
      }
    }
    expect(said).toBe("Un attimo, controllo... ");
    expect(Date.now() - t0).toBeLessThan(200);
    await reader.cancel();
  });

  it("holding back punctuation never changes a reply that just streams, however it is split", async () => {
    const parsed = await chunks(voiceSseFromCompletion(streamOf([
      up({ content: "Ciao" }), up({ content: "." }), up({ content: " " }), up({ content: "Come stai?" }),
      up({ content: " Bene," }), up({ content: " grazie!" }), "data: [DONE]\n\n",
    ]), "v", { language: "it" }));
    expect(contentOf(parsed)).toBe("Ciao. Come stai? Bene, grazie!");
  });

  it("internal tools (memory...) get a longer grace period, then a plain filler", async () => {
    const quick = await chunks(voiceSseFromCompletion(timedStreamOf([
      tool("memory_append", "calling"), { wait: 100 }, up({ content: "Me lo ricordo." }), "data: [DONE]\n\n",
    ]), "v", { language: "it", timing: FAST, pick: first }));
    expect(spokenParts(quick)).toEqual(["Me lo ricordo."]);
    const slow = await chunks(voiceSseFromCompletion(timedStreamOf([
      tool("memory_append", "calling"), { wait: 250 }, up({ content: "Fatto." }), "data: [DONE]\n\n",
    ]), "v", { language: "it", timing: FAST, pick: first }));
    expect(spokenParts(slow)).toEqual([F(VOICE_FILLERS.it.generic[0]), "Fatto."]);
  });

  it("keeps quiet for a quick tool whose answer comes before the wait is over", async () => {
    const parsed = await chunks(voiceSseFromCompletion(timedStreamOf([
      tool("memory_get", "preparing"), { wait: 10 }, tool("memory_get", "completed"),
      up({ content: "Ti chiami Alessio." }), "data: [DONE]\n\n",
    ]), "v", { language: "it", timing: FAST, pick: first }));
    expect(spokenParts(parsed)).toEqual(["Ti chiami Alessio."]);
  });

  it("does not add its own filler when the agent already announced the tool", async () => {
    const parsed = await chunks(voiceSseFromCompletion(timedStreamOf([
      up({ content: "Un attimo, controllo." }), tool("search_web", "calling"), { wait: 150 },
      up({ content: "Fatto." }), "data: [DONE]\n\n",
    ]), "v", { language: "it", timing: FAST, pick: first }));
    expect(spokenParts(parsed)).toEqual(["Un attimo, controllo...", "Fatto."]);
  });

  it("keeps the person company during a long wait: 'searching', then 'one more second', at most maxStill times", async () => {
    const parsed = await chunks(voiceSseFromCompletion(timedStreamOf([
      tool("search_web", "preparing"), { wait: 900 }, up({ content: "Trovato." }), "data: [DONE]\n\n",
    ]), "v", { language: "it", timing: FAST, pick: first }));
    expect(spokenParts(parsed)).toEqual([
      F(VOICE_FILLERS.it.search[0]), F(VOICE_FILLERS.it.still[0]), F(VOICE_FILLERS.it.still[0]), "Trovato.",
    ]);
  });

  it("fills a slow first word with a thinking filler, and still says what it is doing when a tool starts", async () => {
    const parsed = await chunks(voiceSseFromCompletion(timedStreamOf([
      { wait: 180 }, tool("http_fetch", "preparing"), { wait: 120 }, up({ content: "Domani sole." }), "data: [DONE]\n\n",
    ]), "v", { language: "it", timing: FAST, pick: first }));
    expect(spokenParts(parsed)).toEqual([F(VOICE_FILLERS.it.think[0]), F(VOICE_FILLERS.it.fetch[0]), "Domani sole."]);
  });

  it("never fills the pauses of a reply that is simply streaming", async () => {
    const parsed = await chunks(voiceSseFromCompletion(timedStreamOf([
      up({ content: "Allora," }), { wait: 300 }, up({ content: " ecco." }), "data: [DONE]\n\n",
    ]), "v", { language: "it", timing: FAST, pick: first }));
    expect(contentOf(parsed)).toBe("Allora, ecco.");
  });

  it("a filler is not an answer: a turn that then fails still apologises", async () => {
    const parsed = await chunks(voiceSseFromCompletion(timedStreamOf([
      tool("search_web", "preparing"), { wait: 120 },
      `data: ${JSON.stringify({ error: { message: "boom" } })}\n\n`,
    ]), "v", { language: "it", errorText: "Scusa.", timing: FAST, pick: first }));
    expect(spokenParts(parsed)).toEqual([F(VOICE_FILLERS.it.search[0]), "Scusa."]);
  });

  it("an upstream that breaks while a filler timer is pending ends the stream once", async () => {
    const parsed = await chunks(voiceSseFromCompletion(timedStreamOf([
      tool("search_web", "preparing"), { wait: 20 },
    ], new Error("socket hang up")), "v", { language: "it", errorText: "Scusa.", timing: FAST, pick: first }));
    expect(spokenParts(parsed)).toEqual(["Scusa."]);
    expect(parsed.filter((c) => c.choices[0].finish_reason === "stop")).toHaveLength(1);
  });

  it("can be turned off", async () => {
    const parsed = await chunks(voiceSseFromCompletion(timedStreamOf([
      tool("search_web", "preparing"), { wait: 200 }, up({ content: "Ok." }), "data: [DONE]\n\n",
    ]), "v", { fillers: false, timing: FAST }));
    expect(spokenParts(parsed)).toEqual(["Ok."]);
  });

  it("stops its timers when the voice client hangs up during a wait", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(tool("search_web", "preparing"))); },
      cancel() { cancelled = true; },
    });
    const reader = voiceSseFromCompletion(upstream, "v", { timing: FAST }).getReader();
    await reader.read(); // role
    const pending = reader.read();
    await reader.cancel();
    await pending.catch(() => {});
    expect(cancelled).toBe(true);
    await sleep(400); // nothing must be enqueued on a closed stream (would throw)
  });

  it.each([
    ["search_web", "search"], ["search_news", "search"], ["exa_search", "search"], ["web_search", "search"],
    ["http_fetch", "fetch"], ["browser_open", "fetch"], ["memory_get", "recall"], ["memory_append", "generic"],
    ["bash", "generic"], ["", "generic"],
  ])("tool %s gets the %s filler", (name, kind) => {
    expect(fillerKindForTool(name)).toBe(kind);
  });

  it.each([["it", "it"], ["it-IT", "it"], ["IT_it", "it"], ["en", "en"], ["fr", "en"], [undefined, "en"]])(
    "language %s speaks %s fillers", async (language, expected) => {
      const parsed = await chunks(voiceSseFromCompletion(timedStreamOf([
        tool("search_web", "preparing"), { wait: 120 }, up({ content: "x" }), "data: [DONE]\n\n",
      ]), "v", { language: language as string | undefined, timing: FAST, pick: first }));
      expect(spokenParts(parsed)[0]).toBe(F(VOICE_FILLERS[expected as "it" | "en"].search[0]));
    });

  it("every filler set is complete, short and sounds like a sentence", () => {
    for (const lang of Object.values(VOICE_FILLERS)) {
      for (const kind of ["think", "search", "fetch", "recall", "generic", "still"] as const) {
        expect(lang[kind].length).toBeGreaterThanOrEqual(3);
        for (const phrase of lang[kind]) {
          expect(phrase.length).toBeLessThanOrEqual(40);
          expect(phrase).toMatch(/[.!?]$/);
        }
      }
    }
  });

  it("varies the phrase: never the same one twice in a row", () => {
    const pick = createFillerPicker(() => 0); // rng always 0: the naive pick would repeat
    const pool = ["a.", "b.", "c."];
    const said = Array.from({ length: 6 }, () => pick(pool, "search"));
    for (let i = 1; i < said.length; i++) expect(said[i]).not.toBe(said[i - 1]);
  });
});
