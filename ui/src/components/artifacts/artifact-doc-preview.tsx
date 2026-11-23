import { useMemo, useState, type ComponentProps } from "react";
import { defaultRehypePlugins } from "streamdown";
import { RichStreamdown } from "@/components/ai-elements/rich-streamdown";
import { DocumentComment } from "./artifact-doc-comment";
import { decodeDocComment } from "./artifact-doc-comments";
import { embeddedDocImage } from "./artifact-doc-assets";
import { choiceTone, decodeDocChoice, selectedChoice } from "./artifact-doc-choices";
import { DocTabPicker } from "./artifact-doc-tab-navigation";
import { readDocTabs } from "./artifact-doc-tabs";

interface Node {
  tagName?: string;
  properties?: { src?: unknown; preload?: string; autoPlay?: boolean };
  children?: Node[];
}

function restrictEmbeddedMedia() {
  function visit(node: Node): void {
    const src = node.properties?.src;
    if (typeof src === "string" && /^data:/i.test(src.replace(/[\p{Cc} ]/gu, ""))) {
      if (node.tagName !== "img" || !embeddedDocImage(src)) delete node.properties?.src;
    }
    if (node.tagName === "video" && node.properties) {
      node.properties.preload = "none";
      delete node.properties.autoPlay;
      if (typeof src !== "string" || !/^https?:\/\//i.test(src)) delete node.properties.src;
    }
    node.children?.forEach(visit);
  }
  return visit;
}

function docRehypePlugins(): ComponentProps<typeof RichStreamdown>["rehypePlugins"] {
  const sanitizer = defaultRehypePlugins.sanitize;
  if (!Array.isArray(sanitizer)) return Object.values(defaultRehypePlugins);
  const [sanitize, defaults] = sanitizer;
  return [
    defaultRehypePlugins.raw,
    restrictEmbeddedMedia,
    [sanitize, {
      ...defaults,
      tagNames: [...(defaults.tagNames ?? []), "video", "u", "details", "summary"],
      attributes: {
        ...defaults.attributes,
        video: ["src", "controls", "playsInline", "preload", "title", "ariaLabel"],
        span: [...(defaults.attributes?.span ?? []), ["dataPolpoDocFont", "sans", "serif", "mono"], "dataPolpoDocChoice", "dataPolpoDocComment"],
      },
      protocols: { ...defaults.protocols, src: ["http", "https", "data"] },
    }],
    defaultRehypePlugins.harden,
  ];
}

const rehypePlugins = docRehypePlugins();

export function ArtifactDocPreview({ content }: { content: string }) {
  const book = useMemo(() => readDocTabs(content), [content]);
  const [activeId, setActiveId] = useState(book.tabs[0].id);
  const tab = book.tabs.find((candidate) => candidate.id === activeId) ?? book.tabs[0];
  return (
    <>
      {book.tabs.length > 1 && (
        <div className="not-prose mb-4 border-b pb-3">
          <DocTabPicker tabs={book.tabs} activeId={tab.id} onSelect={setActiveId} />
        </div>
      )}
      {tab.content ? <ArtifactDocMarkdown content={tab.content} /> : <p className="text-muted-foreground">This tab is empty.</p>}
    </>
  );
}

const docMarkdownComponents: ComponentProps<typeof RichStreamdown>["components"] = {
  span({ node, children, ...props }) {
    const comment = decodeDocComment(node?.properties?.dataPolpoDocComment);
    if (comment) return <DocumentComment comment={comment} />;
    const choice = decodeDocChoice(node?.properties?.dataPolpoDocChoice);
    if (!choice) return <span {...props}>{children}</span>;
    const option = selectedChoice(choice);
    return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 align-baseline text-xs font-medium leading-tight ${choiceTone[option?.color ?? "slate"]}`}>
      {option?.label ?? choice.name}
    </span>;
  },
};

export function ArtifactDocMarkdown({ content }: { content: string }) {
  return (
    <div className="[&_video]:my-4 [&_video]:max-h-130 [&_video]:w-full [&_video]:rounded-md [&_video]:bg-black [&_details]:my-3 [&_details]:rounded-md [&_details]:border [&_details]:p-3 [&_summary]:cursor-pointer [&_summary]:font-medium [&_[data-polpo-doc-font=sans]]:font-sans [&_[data-polpo-doc-font=serif]]:font-serif [&_[data-polpo-doc-font=mono]]:font-mono">
      <RichStreamdown mode="static" rehypePlugins={rehypePlugins} components={docMarkdownComponents}>{content}</RichStreamdown>
    </div>
  );
}
