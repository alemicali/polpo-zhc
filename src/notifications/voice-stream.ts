/**
 * OpenAI-compatible streams for voice clients (e.g. ElevenLabs Agents' "custom LLM").
 *
 * A voice provider only needs the words to speak: the agent's thinking, tool-call progress
 * and Polpo-specific fields are dropped, and every stream ends with a stop chunk and [DONE]
 * even when the upstream turn breaks, so the speaker never hangs waiting.
 *
 * Silence on a speaker sounds broken, so long waits are filled the way a person would:
 * "let me look it up…" when a tool keeps the line quiet, "one more second…" if it drags on.
 *
 * Voice providers buffer short text until more arrives (ElevenLabs speaks a partial reply only
 * when it ends with "... "), so whatever is said before a pause (a filler, or the agent's own
 * "let me check." right before a tool) ends with "... " to be spoken right away.
 */

const encoder = new TextEncoder();
const DONE = "data: [DONE]\n\n";

export const DEFAULT_VOICE_ERROR_TEXT = "Sorry, something went wrong. Please try again.";

export type FillerKind = "think" | "search" | "fetch" | "recall" | "generic" | "still";
export type FillerLanguage = "it" | "en";

/** Short courtesy phrases, by what the agent is doing while the line is quiet. */
export const VOICE_FILLERS: Record<FillerLanguage, Record<FillerKind, readonly string[]>> = {
  it: {
    think: ["Mmh, vediamo.", "Fammi pensare un attimo.", "Vediamo un po'.", "Allora, un momento."],
    search: ["Sto cercando, un attimo.", "Cerco subito.", "Do un'occhiata online.", "Un attimo, cerco in rete."],
    fetch: ["Controllo subito.", "Un secondo, verifico.", "Vado a vedere.", "Un attimo, guardo."],
    recall: ["Vediamo cosa ricordo.", "Un attimo, ci penso.", "Fammi ricordare."],
    generic: ["Un attimo.", "Un secondo, ci sono.", "Dammi un momento.", "Ci sto lavorando."],
    still: ["Ancora un secondo.", "Ci sono quasi.", "Sto ancora cercando, un momento.", "Abbi pazienza, quasi fatto."],
  },
  en: {
    think: ["Hmm, let me think.", "Let me see.", "One moment.", "Okay, let me see."],
    search: ["Let me look that up.", "Searching now.", "Checking online, one sec.", "Let me search for that."],
    fetch: ["Let me check.", "One second, checking.", "Let me have a look.", "Checking that now."],
    recall: ["Let me remember.", "Let me think back.", "One sec, recalling."],
    generic: ["One moment.", "Just a second.", "Give me a moment.", "Working on it."],
    still: ["Just one more second.", "Almost there.", "Still looking, hang on.", "Nearly done."],
  },
};

export interface VoiceFillerTiming {
  /** Nothing said yet and no tool running: a thinking filler after this long. */
  firstWaitMs: number;
  /** A tool started and the line is quiet: say what is being done after this long. */
  toolWaitMs: number;
  /** Same, for quick internal tools (memory, ...) that rarely need an excuse. */
  quietToolWaitMs: number;
  /** Still quiet after a filler (or the agent's own announcement): "one more second". */
  stillWorkingMs: number;
  /** "One more second" at most this many times per turn. */
  maxStill: number;
}

export const DEFAULT_FILLER_TIMING: VoiceFillerTiming = {
  firstWaitMs: 2500, toolWaitMs: 900, quietToolWaitMs: 1800, stillWorkingMs: 7000, maxStill: 2,
};

export type FillerPicker = (pool: readonly string[], key: string) => string;

export interface VoiceStreamOptions {
  /** Spoken when the turn fails before saying anything. */
  errorText?: string;
  /** Language of the fillers ("it", "it-IT", "en"...); unknown languages use English. */
  language?: string;
  /** Courtesy fillers during long silences (default on). */
  fillers?: boolean;
  timing?: Partial<VoiceFillerTiming>;
  pick?: FillerPicker;
}

/** What the tool is doing, as the person would describe it. */
export function fillerKindForTool(name: string): FillerKind {
  const n = name.toLowerCase();
  if (/search|exa/.test(n)) return "search";
  if (/fetch|http|browse|browser|scrape/.test(n)) return "fetch";
  if (/^memory_(get|read|search)|recall/.test(n)) return "recall";
  return "generic";
}

function fillerLanguage(language: string | undefined): FillerLanguage {
  const base = (language ?? "").toLowerCase().split(/[-_]/)[0];
  return base === "it" ? "it" : "en";
}

/** Random phrase that is never the one said last time for the same kind. */
export function createFillerPicker(rng: () => number = Math.random): FillerPicker {
  const last = new Map<string, string>();
  return (pool, key) => {
    const choices = pool.length > 1 ? pool.filter((p) => p !== last.get(key)) : pool;
    const phrase = choices[Math.min(choices.length - 1, Math.floor(rng() * choices.length))] ?? "";
    last.set(key, phrase);
    return phrase;
  };
}

/** Shared across turns: the speaker should not greet every wait with the same words. */
const defaultPicker = createFillerPicker();

function chunk(id: string, delta: { role?: string; content?: string }, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "polpo",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/** A whole reply already known (a command answer, a pairing code, an apology) as a stream. */
export function voiceSseFromText(text: string, id: string): ReadableStream<Uint8Array> {
  const parts = [chunk(id, { role: "assistant" }), ...(text ? [chunk(id, { content: text })] : []), chunk(id, {}, "stop"), DONE];
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

type Item = { text: string } | { toolStart: string };
interface Parsed { items: Item[]; done: boolean; error: boolean }

/** Complete SSE events in the buffer; returns what they say and the unparsed remainder. */
function drainEvents(buffer: string): { parsed: Parsed; rest: string } {
  const parsed: Parsed = { items: [], done: false, error: false };
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    const data = block.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    if (data === "[DONE]") { parsed.done = true; break; }
    let event: any;
    try { event = JSON.parse(data); } catch { continue; }
    if (event && typeof event === "object" && event.error) { parsed.error = true; break; }
    const choice = event?.choices?.[0];
    // Polpo shows model failures inline in the chat ("\n\nError: ..."), marked error: true: never spoken.
    if (choice?.error === true) { parsed.error = true; break; }
    const toolCall = choice?.tool_call;
    if (toolCall && (toolCall.state === "preparing" || toolCall.state === "calling")) {
      parsed.items.push({ toolStart: typeof toolCall.name === "string" ? toolCall.name : "" });
    }
    const content = choice?.delta?.content;
    if (typeof content === "string" && content) parsed.items.push({ text: content });
  }
  return { parsed, rest };
}

/** The agent's streaming completion (Polpo SSE) as a clean OpenAI stream of spoken text. */
export function voiceSseFromCompletion(
  upstream: ReadableStream<Uint8Array>,
  id: string,
  opts: VoiceStreamOptions = {},
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const errorText = opts.errorText ?? DEFAULT_VOICE_ERROR_TEXT;
  const fillersOn = opts.fillers !== false;
  const timing: VoiceFillerTiming = { ...DEFAULT_FILLER_TIMING, ...opts.timing };
  const phrases = VOICE_FILLERS[fillerLanguage(opts.language)];
  const pick = opts.pick ?? defaultPicker;
  let buffer = "";
  let started = false;
  let spoke = false; // real words of the agent (fillers do not count: a failure still apologises)
  let finished = false;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  // Filler state for the current quiet stretch
  const startedAt = Date.now();
  let lastVoiceAt = startedAt;
  let toolStartedAt: number | null = null; // first tool started since the agent last spoke
  let toolKind: FillerKind = "generic";
  let textBeforeTool = false; // the agent spoke since the previous tool: it announced this one itself
  let gapFiller: FillerKind | null = null; // filler (or announcement) already said in this quiet stretch
  let stillSaid = 0;
  let lastChar = ""; // last character handed to the voice
  // Trailing punctuation of the agent's text, held until we know what follows: more words
  // (said as is) or a pause for a tool (said as "... " so the voice does not sit on it).
  let held = "";
  const PAUSE = "... ";
  const TRAILING = /[\s.!?…:;,]*$/;

  const nextFiller = (): { at: number; kind: FillerKind } | null => {
    if (!fillersOn) return null;
    if (gapFiller === null) {
      if (toolStartedAt !== null) {
        const quiet = toolKind === "recall" || toolKind === "generic";
        return { at: toolStartedAt + (quiet ? timing.quietToolWaitMs : timing.toolWaitMs), kind: toolKind };
      }
      if (!spoke) return { at: startedAt + timing.firstWaitMs, kind: "think" };
      return null; // a reply that is simply streaming
    }
    if (stillSaid < timing.maxStill && (toolStartedAt !== null || !spoke)) {
      return { at: lastVoiceAt + timing.stillWorkingMs, kind: "still" };
    }
    return null;
  };

  const onText = () => {
    spoke = true;
    lastVoiceAt = Date.now();
    toolStartedAt = null;
    gapFiller = null;
    textBeforeTool = true;
  };

  const onToolStart = (name: string) => {
    if (toolStartedAt === null) {
      toolStartedAt = Date.now();
      toolKind = fillerKindForTool(name);
      // "Un attimo, controllo." right before the tool: the agent already said it.
      if (textBeforeTool) gapFiller = "generic";
      // After "let me think", still say what is being done ("searching...").
      else if (gapFiller === "think") gapFiller = null;
    }
    textBeforeTool = false;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let emitted = 0;
      const emit = (s: string) => { controller.enqueue(encoder.encode(s)); emitted++; };
      const say = (text: string) => {
        if (!text) return;
        emit(chunk(id, { content: text }));
        lastChar = text.slice(-1);
      };
      /** Before a pause: what was said so far must be spoken now, not wait for more text. */
      const pause = () => {
        if (held || (lastChar !== "" && lastChar !== " ")) say(PAUSE);
        held = "";
      };
      const agentText = (text: string) => {
        const full = held + text;
        const cut = full.length - (TRAILING.exec(full)?.[0].length ?? 0);
        held = full.slice(cut);
        say(full.slice(0, cut));
      };
      const finish = (failed: boolean) => {
        if (finished) return;
        finished = true;
        if (failed && !spoke) say(`${lastChar && lastChar !== " " ? " " : ""}${errorText}`);
        else say(held);
        held = "";
        emit(chunk(id, {}, "stop"));
        emit(DONE);
        controller.close();
        reader.cancel().catch(() => {});
      };

      if (!started) {
        started = true;
        emit(chunk(id, { role: "assistant" }));
        return;
      }
      while (!finished) {
        if (!pending) {
          pending = reader.read();
          pending.catch(() => {}); // handled below; may outlive a filler wait
        }
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          const filler = nextFiller();
          if (filler) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<"timeout">((resolve) => {
              timer = setTimeout(() => resolve("timeout"), Math.max(0, filler.at - Date.now()));
            });
            const raced = await Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
            if (finished) return;
            if (raced === "timeout") {
              pause();
              say(pick(phrases[filler.kind], filler.kind).replace(/[.!?]+$/, "") + PAUSE);
              lastVoiceAt = Date.now();
              if (filler.kind === "still") stillSaid++;
              gapFiller = filler.kind;
              return; // let the consumer speak it
            }
            result = raced;
          } else {
            result = await pending;
          }
        } catch {
          pending = null;
          finish(true);
          return;
        }
        pending = null;
        if (finished) return;
        if (result.done) buffer += decoder.decode() + "\n\n";
        else buffer += decoder.decode(result.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        const { parsed, rest } = drainEvents(buffer);
        buffer = rest;
        const before = emitted;
        for (const item of parsed.items) {
          if ("text" in item) {
            agentText(item.text);
            onText();
          } else {
            onToolStart(item.toolStart);
            if (held || (lastChar !== "" && lastChar !== " ")) pause();
          }
        }
        if (parsed.error) return finish(true);
        if (parsed.done || result.done) return finish(false);
        // let the consumer read before pulling more (a pull that enqueues nothing is never repeated)
        if (emitted > before) return;
      }
    },
    async cancel(reason) {
      finished = true;
      await reader.cancel(reason).catch(() => {});
    },
  });
}
