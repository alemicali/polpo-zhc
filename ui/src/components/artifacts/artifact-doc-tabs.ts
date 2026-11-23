import { nanoid } from "nanoid";

export interface ArtifactDocTab {
  id: string;
  title: string;
  content: string;
}

export interface ArtifactDocTabs {
  namespace?: string;
  tabs: ArtifactDocTab[];
}

const header = /^<!-- polpo-doc-tabs:v1 ([\w-]{18}) -->\r?\n/;
const legacyTab = (content: string): ArtifactDocTabs => ({
  tabs: [{ id: "main", title: "Tab 1", content }],
});

function titleOf(value: string): string {
  return Array.from(value.trim().replace(/[\r\n\t]+/g, " ")).slice(0, 100).join("") || "Untitled tab";
}

/** Inert Markdown comments keep tab boundaries stable across direct source and tool edits. */
export function readDocTabs(content: string): ArtifactDocTabs {
  const headerMatch = header.exec(content);
  if (!headerMatch) return legacyTab(content);
  const namespace = headerMatch[1];
  const markers = [
    ...content.matchAll(new RegExp(`^<!-- polpo-doc-tab:${namespace} ([\\w-]{1,20}) ([^\\r\\n]+) -->\\r?\\n\\r?\\n`, "gm")),
  ];
  if (markers[0]?.index !== headerMatch[0].length) return legacyTab(content);

  const ids = new Set<string>();
  const tabs: ArtifactDocTab[] = [];
  for (const [index, marker] of markers.entries()) {
    const id = marker[1];
    const start = marker.index + marker[0].length;
    const end = markers[index + 1]?.index ?? content.length;
    if (ids.has(id)) return legacyTab(content);
    ids.add(id);
    const section = content.slice(start, end);
    try {
      tabs.push({
        id,
        title: titleOf(decodeURIComponent(marker[2])),
        content: section.endsWith("\n\n") ? section.slice(0, -2) : section.replace(/\r\n\r\n$/, ""),
      });
    } catch {
      return legacyTab(content);
    }
  }
  return { namespace, tabs };
}

export function writeDocTabs(document: ArtifactDocTabs): string {
  const first = document.tabs[0];
  if (!first) return "";
  if (document.tabs.length === 1 && !document.namespace && first.id === "main" && first.title === "Tab 1") {
    return first.content;
  }

  const namespace = document.namespace ?? nanoid(18);
  const tabSections = document.tabs.map((tab) => {
    const marker = `<!-- polpo-doc-tab:${namespace} ${tab.id} ${encodeURIComponent(titleOf(tab.title))} -->`;
    return `${marker}\n\n${tab.content}\n\n`;
  });
  return `<!-- polpo-doc-tabs:v1 ${namespace} -->\n${tabSections.join("")}`;
}

export function newDocTab(tabs: ArtifactDocTab[], template?: ArtifactDocTab): ArtifactDocTab {
  const titles = new Set(tabs.map((tab) => tab.title));
  const base = template ? `${Array.from(template.title).slice(0, 85).join("")} copy` : "Tab";
  let suffix = template ? 1 : tabs.length + 1;
  const name = () => template && suffix === 1 ? base : `${base} ${suffix}`;
  while (titles.has(name())) suffix += 1;
  return { id: nanoid(12), title: name(), content: template?.content ?? "" };
}
