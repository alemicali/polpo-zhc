import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSystemTools } from "../tools/system-tools.js";
import { hasCopiedLineNumbers, hasEscapedLineBreaks, withoutLineNumbers } from "../tools/line-number-guard.js";

const text = "Il cane dorme sul divano.\nUn gattone guarda il cane.\nAlla fine il cane mangia.\n";
// What models write after reading a file: the read tool's "<n>\t" prefixes, often with a space for the tab
const withSpaces = "1 Il cane dorme sul divano.\n2 Un gattone guarda il cane.\n3 Alla fine il cane mangia.\n";
const withTabs = "1\tIl cane dorme sul divano.\n2\tUn gattone guarda il cane.\n3\tAlla fine il cane mangia.\n";

describe("copied line numbers", () => {
  test("every line numbered consecutively, as read shows it (tab or space, any start, empty lines too)", () => {
    expect(hasCopiedLineNumbers(withSpaces)).toBe(true);
    expect(hasCopiedLineNumbers(withTabs)).toBe(true);
    expect(hasCopiedLineNumbers("12\tfoo\n13\n14\tbar")).toBe(true);
    expect(hasCopiedLineNumbers("1 a\r\n2 b\r\n")).toBe(true);
  });

  test("also with the tab, or the tab and the line breaks, written as escapes (\\t, \\n)", () => {
    // Seen with qwen3:4b: "1\tIl cane…" with a literal backslash-t, and the whole text on one line with literal \n
    const escapedTab = "1\\tIl cane dorme sul divano.\n2\\tUn gattone guarda il cane.\n3\\tAlla fine il cane mangia.\n";
    const allEscaped = "1\\tIl cane dorme sul divano.\\n2\\tUn gattone guarda il cane.\\n3\\tAlla fine il cane mangia.\\n";
    expect(hasCopiedLineNumbers(escapedTab)).toBe(true);
    // ...or with a dot stuck to the text (also seen with qwen3:4b); a markdown list has a space after the dot
    expect(hasCopiedLineNumbers("1.Il cane dorme.\n2.Un gattone.\n3.Alla fine.\n4\n")).toBe(true);
    expect(hasCopiedLineNumbers("1. pane\n2. latte\n")).toBe(false);
    // ...or with no separator at all (seen with qwen3:4b too)
    expect(hasCopiedLineNumbers("1Il cane dorme.\n2Un gattone.\n3Alla fine.\n4\n")).toBe(true);
    expect(withoutLineNumbers("1Il cane.\n2Un gatto.\n")).toBe("Il cane.\nUn gatto.\n");
    // A file of numbers, one per line, is data (seen: "1..10" refused in a group 2 test)
    expect(hasCopiedLineNumbers("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n")).toBe(false);
    expect(hasCopiedLineNumbers("1\\n2\\n3\\n")).toBe(false);
    // ...while copied numbers in front of text with a few empty lines still count
    expect(hasCopiedLineNumbers("1\tTitolo\n2\n3\tTesto\n4\tAltro\n")).toBe(true);
    // Numbers that are data are not line numbers: not consecutive, or not on every line
    expect(hasCopiedLineNumbers("2024 rapporto annuale\n2026 piano\n")).toBe(false);
    expect(hasCopiedLineNumbers("3kg farina\n5kg zucchero\n")).toBe(false);
    // ...and the empty last line copied as "4" followed by a literal \n
    expect(hasCopiedLineNumbers("1\\tIl cane dorme.\n2\\tUn gattone.\n3\\tAlla fine.\n4\\n")).toBe(true);
    expect(hasCopiedLineNumbers(allEscaped)).toBe(true);
    expect(hasEscapedLineBreaks(allEscaped)).toBe(true);
    expect(hasEscapedLineBreaks(escapedTab)).toBe(false);
    expect(withoutLineNumbers(escapedTab)).toBe(text);
    // Code with "\n" inside strings is not line-numbered text
    expect(hasCopiedLineNumbers('const s = "a\\nb";\nconsole.log(s);\n')).toBe(false);
    expect(hasCopiedLineNumbers('{"text":"riga 1\\nriga 2"}')).toBe(false);
  });

  test("ordinary content is not flagged", () => {
    expect(hasCopiedLineNumbers(text)).toBe(false);
    expect(hasCopiedLineNumbers("1 riga sola")).toBe(false);              // one line is too common to tell
    expect(hasCopiedLineNumbers("1. pane\n2. latte\n3. uova")).toBe(false); // a markdown list
    expect(hasCopiedLineNumbers("1 a\n3 b\n4 c")).toBe(false);             // not consecutive
    expect(hasCopiedLineNumbers("1 a\nb\n3 c")).toBe(false);               // a line without a number
    expect(hasCopiedLineNumbers("2024 anno\n2025 anno")).toBe(true);       // ambiguous: refused once, see below
  });

  test("withoutLineNumbers drops the prefix of each line", () => {
    expect(withoutLineNumbers(withSpaces)).toBe(text);
    expect(withoutLineNumbers(withTabs)).toBe(text);
  });
});

describe("write and edit tools", () => {
  let dir: string;
  const tool = (name: string) => createSystemTools(dir).find((t) => t.name === name)!;
  const out = (r: any) => r.content[0].text as string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "polpo-lines-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("write refuses content with copied line numbers and writes the clean retry", async () => {
    const write = tool("write");
    const refused = out(await write.execute("t1", { path: "testo.md", content: withSpaces } as any));
    expect(refused).toMatch(/line number/);
    expect(existsSync(join(dir, "testo.md"))).toBe(false);

    out(await write.execute("t2", { path: "testo.md", content: text } as any));
    expect(readFileSync(join(dir, "testo.md"), "utf8")).toBe(text);
  });

  test("escaped line breaks are named in the error", async () => {
    const refused = out(await tool("write").execute("t1", { path: "t.md", content: "1\\tuno\\n2\\tdue\\n" } as any));
    expect(refused).toMatch(/real line breaks/);
    expect(existsSync(join(dir, "t.md"))).toBe(false);
  });

  test("repeating the same call does not get it through; keep_line_numbers does", async () => {
    // Seen with qwen3:4b: refused, it sent the identical call again
    const write = tool("write");
    const list = "1 pane\n2 latte\n3 uova\n";
    await write.execute("t1", { path: "spesa.txt", content: list } as any);
    await write.execute("t2", { path: "spesa.txt", content: list } as any);
    expect(existsSync(join(dir, "spesa.txt"))).toBe(false);
    await write.execute("t3", { path: "spesa.txt", content: list, keep_line_numbers: true } as any);
    expect(readFileSync(join(dir, "spesa.txt"), "utf8")).toBe(list);
  });

  test("an edit inside a file whose lines really are numbered goes through", async () => {
    writeFileSync(join(dir, "elenco.txt"), "1 pane\n2 latte\n3 uova\n");
    await tool("edit").execute("t1", { path: "elenco.txt", old_text: "2 latte\n3 uova", new_text: "2 burro\n3 uova" } as any);
    expect(readFileSync(join(dir, "elenco.txt"), "utf8")).toBe("1 pane\n2 burro\n3 uova\n");
  });

  test("ordinary content is written at once", async () => {
    await tool("write").execute("t1", { path: "a.md", content: text } as any);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe(text);
  });

  test("edit refuses new_text with copied line numbers, and says why old_text with them is not found", async () => {
    writeFileSync(join(dir, "testo.md"), text);
    const edit = tool("edit");
    const notFound = out(await edit.execute("t1", { path: "testo.md", old_text: "2 Un gattone guarda il cane.", new_text: "x" } as any));
    expect(notFound).toMatch(/not found.*line numbers/s);

    const refused = out(await edit.execute("t2", { path: "testo.md", old_text: text, new_text: withSpaces } as any));
    expect(refused).toMatch(/line number/);
    expect(readFileSync(join(dir, "testo.md"), "utf8")).toBe(text);

    await edit.execute("t3", { path: "testo.md", old_text: "il cane dorme", new_text: "il gatto dorme" } as any);
    expect(readFileSync(join(dir, "testo.md"), "utf8")).toBe(text); // "il cane dorme" is not in the text: unchanged
    await edit.execute("t4", { path: "testo.md", old_text: "Il cane dorme", new_text: "Il gatto dorme" } as any);
    expect(readFileSync(join(dir, "testo.md"), "utf8")).toMatch(/^Il gatto dorme/);
  });

  test("the read tool tells the agent the numbers are not part of the file", () => {
    expect(tool("read").description).toMatch(/not part of the file/);
  });
});
