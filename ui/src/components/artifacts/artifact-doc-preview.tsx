import type { ComponentProps } from "react";
import { defaultRehypePlugins } from "streamdown";
import { RichStreamdown } from "@/components/ai-elements/rich-streamdown";
import { embeddedDocImage } from "./artifact-doc-assets";

interface Node {
  tagName?: string;
  properties?: { src?: unknown };
  children?: Node[];
}

function restrictEmbeddedImages() {
  function visit(node: Node): void {
    const src = node.properties?.src;
    if (typeof src === "string" && /^data:/i.test(src.replace(/[\p{Cc} ]/gu, ""))) {
      if (node.tagName !== "img" || !embeddedDocImage(src)) delete node.properties?.src;
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
    restrictEmbeddedImages,
    [sanitize, {
      ...defaults,
      protocols: { ...defaults.protocols, src: ["http", "https", "data"] },
    }],
    defaultRehypePlugins.harden,
  ];
}

const rehypePlugins = docRehypePlugins();

export function ArtifactDocPreview({ content }: { content: string }) {
  return <RichStreamdown mode="static" rehypePlugins={rehypePlugins}>{content}</RichStreamdown>;
}
