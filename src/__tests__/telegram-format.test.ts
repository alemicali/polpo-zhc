import { describe, it, expect, vi, afterEach } from "vitest";
import { markdownToTelegramHtml as md, splitMarkdown } from "../notifications/telegram-format.js";
import { TelegramCallbackPoller } from "../notifications/channels/telegram.js";

describe("markdownToTelegramHtml", () => {
  it("formats inline styles", () => {
    expect(md("**bold** and *italic* and _also_ and ~~gone~~ and `x<y`"))
      .toBe("<b>bold</b> and <i>italic</i> and <i>also</i> and <s>gone</s> and <code>x&lt;y</code>");
  });

  it("does not italicize snake_case names or arithmetic", () => {
    expect(md("open food_log_eod and weight_log, 2 * 3 * 4")).toBe("open food_log_eod and weight_log, 2 * 3 * 4");
  });

  it("maps headings, lists, tasks, rules and quotes", () => {
    expect(md("# Piano\n## Oggi\n- uova\n  - toast\n1. primo\n- [x] fatto\n- [ ] da fare\n---\n> nota *importante*")).toBe(
      "<b>Piano</b>\n<b>Oggi</b>\n• uova\n  • toast\n1. primo\n☑ fatto\n☐ da fare\n──────────\n<blockquote>nota <i>importante</i></blockquote>",
    );
  });

  it("makes links clickable and escapes HTML", () => {
    expect(md("see [docs](https://ex.com/a?b=1&c=2) <script>"))
      .toBe('see <a href="https://ex.com/a?b=1&amp;c=2">docs</a> &lt;script&gt;');
  });

  it("keeps code blocks verbatim", () => {
    expect(md("```ts\nconst a = **b** < 1\n```")).toBe('<pre><code class="language-ts">const a = **b** &lt; 1</code></pre>');
    expect(md("```\nplain\n```")).toBe("<pre>plain</pre>");
  });

  it("renders tables as aligned monospace text", () => {
    expect(md("| Pasto | kcal |\n|---|---:|\n| **Pranzo** | 650 |\n| Cena | 1200 |")).toBe(
      "<pre>Pasto   kcal\nPranzo  650\nCena    1200</pre>",
    );
  });
});

describe("splitMarkdown", () => {
  it("keeps short text in one chunk", () => {
    expect(splitMarkdown("a\n\nb")).toEqual(["a\n\nb"]);
  });

  it("splits on paragraph boundaries under the limit", () => {
    const para = "x".repeat(60);
    const chunks = splitMarkdown(Array(5).fill(para).join("\n\n"), 130);
    expect(chunks).toEqual([`${para}\n\n${para}`, `${para}\n\n${para}`, para]);
  });

  it("does not split a fenced code block that fits", () => {
    const code = "```\n" + "line\n".repeat(10) + "```";
    const chunks = splitMarkdown(`${"i".repeat(40)}\n\n${code}\n\noutro`, 80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some(c => c.includes(code))).toBe(true);
  });

  it("hard-cuts a single oversized line", () => {
    const chunks = splitMarkdown("y".repeat(250), 100);
    expect(chunks.map(c => c.length)).toEqual([100, 100, 50]);
  });
});

describe("TelegramCallbackPoller.sendMarkdown", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends long replies as several messages, buttons on the last one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const poller = new TelegramCallbackPoller("123:abc", "1");
    const text = Array(3).fill("z".repeat(3000)).join("\n\n");

    await poller.sendMarkdown("chat", text, [[{ text: "ok", data: "agent:x" }]]);

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies).toHaveLength(3);
    expect(bodies.every(b => b.text.length <= 4096 && b.parse_mode === "HTML")).toBe(true);
    expect(bodies.slice(0, 2).every(b => !b.reply_markup)).toBe(true);
    expect(bodies[2].reply_markup.inline_keyboard[0][0]).toEqual({ text: "ok", callback_data: "agent:x" });
  });

  it("resends as plain text when Telegram rejects the HTML", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await new TelegramCallbackPoller("123:abc", "1").sendMarkdown("chat", "**ciao**");

    const [first, second] = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(first.parse_mode).toBe("HTML");
    expect(second.parse_mode).toBeUndefined();
    expect(second.text).toBe("**ciao**");
  });
});
