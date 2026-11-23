import type { ComponentProps } from "react";
import { defaultRehypePlugins } from "streamdown";
import { RichStreamdown } from "@/components/ai-elements/rich-streamdown";
import { embeddedDocImage } from "./artifact-doc-assets";

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
      tagNames: [...(defaults.tagNames ?? []), "video"],
      attributes: {
        ...defaults.attributes,
        video: ["src", "controls", "playsInline", "preload", "title", "ariaLabel"],
      },
      protocols: { ...defaults.protocols, src: ["http", "https", "data"] },
    }],
    defaultRehypePlugins.harden,
  ];
}

const rehypePlugins = docRehypePlugins();

export function ArtifactDocPreview({ content }: { content: string }) {
  return (
    <div className="[&_video]:my-4 [&_video]:max-h-130 [&_video]:w-full [&_video]:rounded-md [&_video]:bg-black">
      <RichStreamdown mode="static" rehypePlugins={rehypePlugins}>{content}</RichStreamdown>
    </div>
  );
}
