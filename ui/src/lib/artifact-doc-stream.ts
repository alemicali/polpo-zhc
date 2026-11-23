import { readDocTabs, writeDocTabs } from "@/components/artifacts/artifact-doc-tabs";
import type { ToolCallInfo } from "@/hooks/use-polpo";
import { projectArtifactText } from "./artifact-stream-text";

const metadata = [
  ["<!-- polpo-doc-tabs:", "-->"],
  ["<!-- polpo-doc-tab:", "-->"],
  ['<span data-polpo-doc-choice="', "</span>"],
  ['<span data-polpo-doc-comment="', "</span>"],
] as const;

function visiblePrefix(text: string): string {
  let end = text.length;
  // The raw Markdown carries tab and annotation structure. Do not show an unfinished
  // opening marker as prose while its JSON string is still arriving.
  for (const [start, close] of metadata) {
    const opening = text.lastIndexOf(start);
    if (opening > text.lastIndexOf(close)) end = Math.min(end, opening);
    const max = Math.min(start.length - 1, text.length);
    for (let size = max; size >= 2; size -= 1) {
      const prefix = start.slice(0, size);
      if (text.endsWith(prefix) && (prefix.startsWith("<!") || size > "<span".length)) {
        end = Math.min(end, text.length - size);
        break;
      }
    }
  }
  // Some providers split a Unicode code point across argument chunks.
  return text.slice(0, end).replace(/[\uD800-\uDBFF]$/, "");
}

const paragraphGap = /\r?\n[\t ]*\r?\n/;

function keepParagraphSuffix(prefix: string, previous: string): string {
  if (previous.startsWith(prefix)) return previous;
  if (!previous || prefix.startsWith(previous)) return prefix;
  if (/^ {0,3}(?:`{3,}|~{3,})/m.test(prefix) || /^ {0,3}(?:`{3,}|~{3,})/m.test(previous)) return prefix;

  const before = previous.split(paragraphGap);
  const incoming = prefix.split(paragraphGap);
  let common = 0;
  while (common < before.length && common < incoming.length && before[common] === incoming[common]) common += 1;
  if (common === 0 || common === before.length) return prefix;

  // One changed paragraph after an unchanged prefix is an unambiguous place to
  // retain the old tail. Once the author introduces multiple changes, the old
  // paragraph positions are no longer a safe representation of the new draft.
  const startsOldTail = incoming.length === common + 2 && before[common + 1]?.startsWith(incoming[common + 1]);
  if (incoming.length !== common + 1 && !startsOldTail) return prefix;
  const separators = [...previous.matchAll(new RegExp(paragraphGap.source, "g"))];
  const boundary = separators[common]?.index;
  if (boundary === undefined) return prefix;
  const endOfPrefix = startsOldTail
    ? [...prefix.matchAll(new RegExp(paragraphGap.source, "g"))].at(-1)?.index
    : prefix.length;
  return prefix.slice(0, endOfPrefix) + previous.slice(boundary);
}

export function projectDocStream(tool: ToolCallInfo, args: Record<string, unknown>, base?: string): string | undefined {
  if (tool.state === "interrupted" || (args.type !== undefined && args.type !== "doc")) return;
  const projection = projectArtifactText(tool, args, base);
  if (!projection) return;
  // Targeted changes already preserve the exact prefix and suffix through the
  // common projector. A complete replacement is also authoritative.
  if (projection.complete || typeof args.content !== "string") return projection.text;

  const prefix = visiblePrefix(projection.text);
  if (base === undefined) return prefix || undefined;

  const saved = readDocTabs(base);
  const draft = readDocTabs(prefix);
  if (!saved.namespace) {
    return draft.namespace ? prefix : keepParagraphSuffix(prefix, base);
  }
  if (!draft.namespace) return base;
  if (draft.namespace !== saved.namespace) return prefix;

  const included = new Set(draft.tabs.map((tab) => tab.id));
  const tabs = draft.tabs.map((tab, index) => {
    if (index !== draft.tabs.length - 1) return tab;
    const prior = saved.tabs.find((entry) => entry.id === tab.id);
    return prior ? { ...tab, content: keepParagraphSuffix(tab.content, prior.content) } : tab;
  });
  tabs.push(...saved.tabs.filter((tab) => !included.has(tab.id)));
  return writeDocTabs({ namespace: saved.namespace, tabs });
}
