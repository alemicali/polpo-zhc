import { Editor, Mark, Node, type JSONContent } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { StarterKit } from "@tiptap/starter-kit";
import { readDocTabs } from "./artifact-doc-tabs";
import { choiceToMarkdown, decodeDocChoice, encodeDocChoice, selectedChoice } from "./artifact-doc-choices";
import { DocChoiceChip } from "./artifact-doc-choice-chip";
import { DocCommentMarker } from "./artifact-doc-comment-marker";
import { decodeDocComment } from "./artifact-doc-comments";

export function artifactDocUrl(value: string, image: boolean): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || (!image && url.protocol === "mailto:");
  } catch {
    return false;
  }
}

const escapeAttribute = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const docVideoBlock = /^ {0,3}<video\b[^>\n]*>[ \t]*<\/video>[ \t]*(?:\r?\n|$)/i;

const DocVideo = Node.create({
  name: "docVideo",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { src: { default: "" }, title: { default: "Video" } };
  },
  parseHTML() {
    return [{
      tag: "video[src]",
      getAttrs: (element) => {
        const src = element.getAttribute("src") ?? "";
        return artifactDocUrl(src, true) ? { src, title: element.getAttribute("title") || "Video" } : false;
      },
    }];
  },
  renderHTML({ node }) {
    return ["video", {
      src: node.attrs.src,
      title: node.attrs.title,
      "aria-label": node.attrs.title,
      controls: "",
      playsinline: "",
      preload: "none",
    }];
  },
  markdownTokenizer: {
    name: "docVideo",
    level: "block",
    start: (source) => source.search(/^ {0,3}<video\b/im),
    tokenize(source) {
      const block = docVideoBlock.exec(source)?.[0];
      if (!block) return;
      const parsed = new DOMParser().parseFromString(block, "text/html").querySelector("video[src]");
      const src = parsed?.getAttribute("src") ?? "";
      if (!artifactDocUrl(src, true)) return;
      return { type: "docVideo", raw: block, src, title: parsed?.getAttribute("title") || "Video" };
    },
  },
  parseMarkdown(token, helpers) {
    return helpers.createNode("docVideo", { src: token.src, title: token.title });
  },
  renderMarkdown(node) {
    const src = escapeAttribute(String(node.attrs?.src ?? ""));
    const title = escapeAttribute(String(node.attrs?.title ?? "Video"));
    return `<video controls playsinline preload="none" src="${src}" title="${title}"></video>`;
  },
});

const DocComment = Node.create({
  name: "docComment",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { comment: { default: "", rendered: false } };
  },
  parseHTML() {
    return [{
      tag: "span[data-polpo-doc-comment]",
      getAttrs: (element) => {
        const comment = element.getAttribute("data-polpo-doc-comment");
        return decodeDocComment(comment) ? { comment } : false;
      },
    }];
  },
  renderHTML({ node }) {
    return ["span", { "data-polpo-doc-comment": node.attrs.comment, "aria-hidden": "true" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(DocCommentMarker);
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey("docCommentHighlights"),
      props: {
        decorations(state) {
          const items: Decoration[] = [];
          state.doc.descendants((node, position) => {
            if (node.type.name !== "docComment") return;
            const comment = decodeDocComment(node.attrs.comment);
            if (comment?.resolved || !comment?.length || !comment.quote || position < comment.length) return;
            const start = position - comment.length;
            if (state.doc.textBetween(start, position, "\n").trim() === comment.quote) {
              items.push(Decoration.inline(start, position, { class: "rounded-sm bg-warning/20" }));
            }
          });
          return DecorationSet.create(state.doc, items);
        },
      },
    })];
  },
  markdownTokenizer: {
    name: "docComment",
    level: "inline",
    start: '<span data-polpo-doc-comment="',
    tokenize(source) {
      const match = /^<span data-polpo-doc-comment="([^"\r\n]+)"><\/span>/.exec(source);
      return match && decodeDocComment(match[1])
        ? { type: "docComment", raw: match[0], comment: match[1] } : undefined;
    },
  },
  parseMarkdown(token, helpers) {
    return helpers.createNode("docComment", { comment: token.comment });
  },
  renderMarkdown(node) {
    return decodeDocComment(node.attrs?.comment)
      ? `<span data-polpo-doc-comment="${node.attrs?.comment}"></span>` : "";
  },
});

const DocChoice = Node.create({
  name: "docChoice",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { choice: { default: "", rendered: false } };
  },
  parseHTML() {
    return [{
      tag: "span[data-polpo-doc-choice]",
      getAttrs: (element) => {
        const value = element.getAttribute("data-polpo-doc-choice");
        return decodeDocChoice(value) ? { choice: value } : false;
      },
    }];
  },
  renderHTML({ node }) {
    const choice = decodeDocChoice(node.attrs.choice);
    const text = choice ? selectedChoice(choice)?.label ?? choice.name : "Dropdown";
    return ["span", { "data-polpo-doc-choice": choice ? encodeDocChoice(choice) : "" }, text];
  },
  addNodeView() {
    return ReactNodeViewRenderer(DocChoiceChip);
  },
  markdownTokenizer: {
    name: "docChoice",
    level: "inline",
    start: '<span data-polpo-doc-choice="',
    tokenize(source) {
      const match = /^<span data-polpo-doc-choice="([^"\r\n]+)">[^<]*<\/span>/.exec(source);
      return match && decodeDocChoice(match[1]) ? { type: "docChoice", raw: match[0], choice: match[1] } : undefined;
    },
  },
  parseMarkdown(token, helpers) {
    return helpers.createNode("docChoice", { choice: token.choice });
  },
  renderMarkdown(node) {
    const choice = decodeDocChoice(node.attrs?.choice);
    if (!choice) return "Dropdown";
    return choiceToMarkdown(choice);
  },
});

const dropdownBlock = /^ {0,3}<details data-polpo-dropdown=""><summary>[^\r\n]*?<\/summary><p>[^\r\n]*?<\/p><\/details>[ \t]*(?:\r?\n|$)/i;

function readDropdownElement(element: ParentNode) {
  return {
    title: element.querySelector("summary")?.textContent || "Details",
    body: Array.from(element.querySelector("p")?.childNodes ?? []).map((node) =>
      node.nodeName === "BR" ? "\n" : node.textContent ?? ""
    ).join(""),
  };
}

const DocDropdown = Node.create({
  name: "docDropdown",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { title: { default: "Details" }, body: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "details[data-polpo-dropdown]", getAttrs: readDropdownElement }];
  },
  renderHTML({ node }) {
    const body = String(node.attrs.body ?? "").split("\n");
    return ["details", { "data-polpo-dropdown": "" },
      ["summary", String(node.attrs.title ?? "Details")],
      ["p", ...body.flatMap((line, i) => i ? [["br"], line] : [line])],
    ];
  },
  markdownTokenizer: {
    name: "docDropdown",
    level: "block",
    start: (source) => source.search(/^ {0,3}<details data-polpo-dropdown=""/im),
    tokenize(source) {
      const raw = dropdownBlock.exec(source)?.[0];
      if (!raw) return;
      const parsed = new DOMParser().parseFromString(raw, "text/html");
      return { type: "docDropdown", raw, ...readDropdownElement(parsed) };
    },
  },
  parseMarkdown(token, helpers) {
    return helpers.createNode("docDropdown", { title: token.title, body: token.body });
  },
  renderMarkdown(node) {
    const title = escapeAttribute(String(node.attrs?.title ?? "Details"));
    const body = escapeAttribute(String(node.attrs?.body ?? "")).replaceAll("\n", "<br>");
    return `<details data-polpo-dropdown=""><summary>${title}</summary><p>${body}</p></details>`;
  },
});

export const docFontFamilies = ["sans", "serif", "mono"] as const;

const DocFont = Mark.create({
  name: "docFont",
  addAttributes() {
    return { family: { default: "sans" } };
  },
  parseHTML() {
    return [{
      tag: "span[data-polpo-doc-font]",
      getAttrs: (element) => {
        const family = docFontFamilies.find((name) => element.getAttribute("data-polpo-doc-font") === name);
        return family ? { family } : false;
      },
    }];
  },
  renderHTML({ mark }) {
    return ["span", { "data-polpo-doc-font": mark.attrs.family }, 0];
  },
  markdownTokenizer: {
    name: "docFont",
    level: "inline",
    start: '<span data-polpo-doc-font="',
    tokenize(source, _tokens, lexer) {
      const match = /^<span data-polpo-doc-font="(sans|serif|mono)">([\s\S]+?)<\/span>/.exec(source);
      return match ? { type: "docFont", raw: match[0], family: match[1], tokens: lexer.inlineTokens(match[2]) } : undefined;
    },
  },
  parseMarkdown(token, helpers) {
    return helpers.applyMark("docFont", helpers.parseInline(token.tokens ?? []), { family: token.family });
  },
  renderMarkdown(node, helpers) {
    const family = docFontFamilies.find((name) => node.attrs?.family === name) ?? "sans";
    return `<span data-polpo-doc-font="${family}">${helpers.renderChildren(node)}</span>`;
  },
});

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
  }),
  DocAlert,
  DocVideo,
  DocChoice,
  DocComment,
  DocDropdown,
  DocFont,
  Image.configure({ inline: true, allowBase64: true, HTMLAttributes: { referrerpolicy: "no-referrer" } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit.configure({ table: { resizable: false } }),
  Markdown.configure({ markedOptions: { gfm: true } }),
];

function readArtifactDocTab(content: string) {
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


export function readArtifactDoc(content: string) {
  const book = readDocTabs(content);
  if (!book.namespace) return readArtifactDocTab(content);

  const children: JSONContent[] = [];
  const pages: string[] = [];
  for (const [index, tab] of book.tabs.entries()) {
    const { html, json } = readArtifactDocTab(tab.content);
    children.push({
      type: "heading",
      attrs: { level: 1, tabStart: index > 0 },
      content: [{ type: "text", text: tab.title }],
    }, ...(json.content ?? []));
    pages.push(`<section data-doc-tab><h1>${escapeAttribute(tab.title)}</h1>${html}</section>`);
  }
  return { html: pages.join(""), json: { type: "doc", content: children } as JSONContent };
}
