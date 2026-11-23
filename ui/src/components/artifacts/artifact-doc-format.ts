import { Editor, Node } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { StarterKit } from "@tiptap/starter-kit";

export function artifactDocUrl(value: string, image: boolean): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || (!image && url.protocol === "mailto:");
  } catch {
    return false;
  }
}

const alertName = /^(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)$/;

const DocAlert = Node.create({
  name: "docAlert",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return { kind: { default: "NOTE", rendered: false } };
  },
  parseHTML() {
    return [{ tag: "blockquote[data-alert]", getAttrs: (element) => {
      const kind = element.getAttribute("data-alert") ?? "";
      return alertName.test(kind) ? { kind } : false;
    } }];
  },
  renderHTML({ node }) {
    return ["blockquote", { "data-alert": node.attrs.kind }, 0];
  },
  markdownTokenizer: {
    name: "docAlert",
    level: "block",
    start: (src) => src.search(/^ {0,3}>[ \t]*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/m),
    tokenize(src, _tokens, lexer) {
      const match = /^ {0,3}>[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)((?: {0,3}>[^\n]*(?:\n|$))*)/.exec(src);
      if (!match) return;
      const body = match[2].replace(/^ {0,3}> ?/gm, "");
      return { type: "docAlert", raw: match[0], kind: match[1], tokens: lexer.blockTokens(body) };
    },
  },
  parseMarkdown(token, helpers) {
    return helpers.createNode("docAlert", { kind: token.kind }, helpers.parseChildren(token.tokens ?? []));
  },
  renderMarkdown(node, helpers) {
    const body = helpers.renderChildren(node.content ?? [], "\n\n").trim();
    const header = `> [!${node.attrs?.kind}]`;
    return body ? `${header}\n${body.split("\n").map((line) => line ? `> ${line}` : ">").join("\n")}` : header;
  },
});

const DocStarterKit = StarterKit.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map((extension) => {
      if (extension.name !== "paragraph") return extension;
      return extension.extend({
        parseMarkdown(token, helpers) {
          const tokens = token.tokens ?? [];
          // Keep a standalone Markdown image in a paragraph because this schema uses inline images.
          if (tokens.length === 1 && tokens[0].type === "image") {
            return helpers.createNode("paragraph", undefined, helpers.parseInline(tokens));
          }
          return this.parent?.(token, helpers) ?? null;
        },
      });
    });
  },
});

export const artifactDocExtensions = [
  DocStarterKit.configure({
    link: { openOnClick: false, defaultProtocol: "https" },
    // Underline is not part of Markdown and would otherwise disappear on serialization.
    underline: false,
  }),
  DocAlert,
  Image.configure({ inline: true, allowBase64: true, HTMLAttributes: { referrerpolicy: "no-referrer" } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit.configure({ table: { resizable: false } }),
  Markdown.configure({ markedOptions: { gfm: true } }),
];

export function readArtifactDoc(content: string) {
  const editor = new Editor({
    extensions: artifactDocExtensions,
    content,
    contentType: "markdown",
  });
  try {
    return { html: editor.getHTML(), json: editor.getJSON() };
  } finally {
    editor.destroy();
  }
}
