import type { JSONContent } from "@tiptap/core";
import type { ILevelsOptions, IParagraphOptions, Paragraph, ParagraphChild, Table } from "docx";
import { embeddedDocImage } from "./artifact-doc-assets";
import { artifactDocUrl, readArtifactDoc } from "./artifact-doc-format";

const printStyles = `
  @page { margin: 18mm; }
  body { color: #182033; max-width: 760px; margin: 24px auto; padding: 0 1rem; font: 12pt/1.55 system-ui, sans-serif; }
  h1,h2,h3,h4,h5,h6 { line-height: 1.2; break-after: avoid; }
  p { orphans: 3; widows: 3; }
  img, video { max-width: 100%; max-height: 70vh; }
  video { display: none; }
  table { width: 100%; border-collapse: collapse; margin: 1em 0; }
  thead { display: table-header-group; }
  th,td { text-align: left; padding: .4em; border: 1px solid #cbd5e1; }
  th, pre { background: #f1f5f9; }
  pre { padding: .8em; white-space: pre-wrap; overflow-wrap: anywhere; }
  blockquote { margin-left: 0; padding-left: 1em; border-left: 2px solid #cbd5e1; }
  blockquote[data-alert]::before { content: attr(data-alert); display: block; font-weight: 650; }
  ul[data-type="taskList"] { list-style: none; padding-left: 1.2em; }
  li[data-type="taskItem"] { display: flex; gap: .5em; }
  li p { margin: 0; }
  @media print { body { margin: 0; padding: 0; } }
`;

export function printArtifactDoc(content: string, title: string): void {
  const { html } = readArtifactDoc(content);
  const popup = window.open("", "_blank", "popup");
  if (!popup) throw new Error("Allow pop-ups to print this document.");
  popup.opener = null;
  const page = popup.document;
  page.title = title;
  const style = page.createElement("style");
  style.textContent = printStyles;
  page.head.append(style);
  const policy = page.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; base-uri 'none'; form-action 'none'";
  page.head.prepend(policy);
  // Only schema-generated markup reaches the print window. Markdown HTML is parsed into editor nodes first.
  page.body.innerHTML = html;
  for (const video of page.querySelectorAll("video")) {
    const href = video.getAttribute("src") ?? "";
    const link = page.createElement("a");
    link.textContent = video.title || "Video";
    if (artifactDocUrl(href, true)) link.href = href;
    video.replaceWith(link);
  }
  const images = Array.from(page.images);
  const ready = Promise.allSettled(images.map((image) => image.decode()));
  void Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 2500))]).then(() => {
    if (!popup.closed) {
      popup.focus();
      popup.print();
    }
  });
}

export async function artifactDocToWord(content: string, title?: string): Promise<Blob> {
  const { json } = readArtifactDoc(content);
  const {
    BorderStyle, Document, ExternalHyperlink, HeadingLevel, ImageRun, LevelFormat,
    Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
  } = await import("docx");
  const headings = [
    HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
  ];
  const numbering: { reference: string; levels: ILevelsOptions[] }[] = [];

  const inline = async (node: JSONContent): Promise<ParagraphChild[]> => {
    if (node.type === "hardBreak") return [new TextRun({ break: 1 })];
    if (node.type === "image") {
      const src = String(node.attrs?.src ?? "");
      const alt = String(node.attrs?.alt || "Image");
      const encoded = embeddedDocImage(src);
      if (encoded) {
        try {
          const data = Uint8Array.from(atob(encoded[2]), (byte) => byte.charCodeAt(0));
          const imageType = encoded[1].toLowerCase().replace("jpeg", "jpg") as "jpg" | "png" | "gif" | "bmp" | "webp";
          const bitmap = await createImageBitmap(new Blob([data], { type: `image/${imageType === "jpg" ? "jpeg" : imageType}` }));
          try {
            const scale = Math.min(1, 540 / bitmap.width, 680 / bitmap.height);
            const transformation = {
              width: Math.max(1, Math.round(bitmap.width * scale)),
              height: Math.max(1, Math.round(bitmap.height * scale)),
            };
            const altText = { title: alt, description: alt, name: alt };
            if (imageType !== "webp") {
              return [new ImageRun({ type: imageType, data, transformation, altText })];
            }
            const canvas = new OffscreenCanvas(transformation.width, transformation.height);
            canvas.getContext("2d")?.drawImage(bitmap, 0, 0, transformation.width, transformation.height);
            const png = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
            return [new ImageRun({ type: "png", data: png, transformation, altText })];
          } finally {
            bitmap.close();
          }
        } catch {
          return [new TextRun(alt)];
        }
      }
      return artifactDocUrl(src, true)
        ? [new ExternalHyperlink({ link: src, children: [new TextRun({ text: alt, style: "Hyperlink" })] })]
        : [new TextRun(alt)];
    }
    if (node.type !== "text") return (await Promise.all((node.content ?? []).map(inline))).flat();
    const marks = new Set((node.marks ?? []).map((mark) => mark.type));
    const href = node.marks?.find((mark) => mark.type === "link")?.attrs?.href;
    const options = {
      text: node.text ?? "",
      bold: marks.has("bold"),
      italics: marks.has("italic"),
      strike: marks.has("strike"),
      ...(marks.has("code") ? { font: "Consolas" } : {}),
    };
    return typeof href === "string" && artifactDocUrl(href, false)
      ? [new ExternalHyperlink({ link: href, children: [new TextRun({ ...options, style: "Hyperlink" })] })]
      : [new TextRun(options)];
  };

  type Block = Paragraph | Table;
  type List = { reference?: string; depth: number; checked?: boolean };

  const block = async (node: JSONContent, indent = 0, list?: List): Promise<Block[]> => {
    const children = node.content ?? [];
    const paragraph = async (extra: IParagraphOptions = {}) => {
      const runs = (await Promise.all(children.map(inline))).flat();
      if (list?.checked !== undefined) runs.unshift(new TextRun(list.checked ? "☑  " : "☐  "));
      return new Paragraph({
        ...extra,
        children: runs,
        ...(list?.reference
          ? { numbering: { reference: list.reference, level: list.depth } }
          : indent ? { indent: { left: indent } } : {}),
      });
    };

    switch (node.type) {
      case "image":
        return [new Paragraph({ children: await inline(node) })];
      case "docVideo": {
        const link = String(node.attrs?.src ?? "");
        const title = String(node.attrs?.title || "Video");
        const children = artifactDocUrl(link, true)
          ? [new ExternalHyperlink({ link, children: [new TextRun({ text: title, style: "Hyperlink" })] })]
          : [new TextRun(title)];
        return [new Paragraph({ children })];
      }
      case "heading":
        return [await paragraph({ heading: headings[Number(node.attrs?.level) - 1] ?? HeadingLevel.HEADING_1 })];
      case "codeBlock":
        return (children.map((child) => child.text ?? "").join("").split("\n")).map((text) => new Paragraph({
          children: [new TextRun({ text, font: "Consolas", size: 20 })],
          indent: { left: indent + 180 },
          spacing: { after: 0 },
        }));
      case "horizontalRule":
        return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" } }, spacing: { after: 160 } })];
      case "docAlert":
        return [
          new Paragraph({ children: [new TextRun({ text: String(node.attrs?.kind ?? ""), bold: true })], indent: { left: indent + 360 } }),
          ...(await Promise.all(children.map((child) => block(child, indent + 360, list)))).flat(),
        ];
      case "blockquote":
        return (await Promise.all(children.map((child) => block(child, indent + 360, list)))).flat();
      case "bulletList":
      case "orderedList":
      case "taskList": {
        const depth = list ? Math.min(list.depth + 1, 8) : 0;
        const ordered = node.type === "orderedList";
        const reference = node.type === "taskList" ? undefined : `list-${numbering.length}`;
        if (reference) {
          numbering.push({ reference, levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            start: ordered ? Number(node.attrs?.start) || 1 : 1,
            format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
            text: ordered ? `%${level + 1}.` : "•",
            style: { paragraph: { indent: { left: indent + 360 * (level + 1), hanging: 220 } } },
          })) });
        }
        return (await Promise.all(children.map(async (item) => {
          const [first, ...rest] = item.content ?? [];
          const itemIndent = indent + 360 * (depth + 1);
          const listItem: List = { reference, depth, checked: !reference ? Boolean(item.attrs?.checked) : undefined };
          return [
            ...(first ? await block(first, itemIndent, listItem) : []),
            ...(await Promise.all(rest.map((child) => child.type?.endsWith("List")
              ? block(child, indent, listItem)
              : block(child, itemIndent)))).flat(),
          ];
        }))).flat();
      }
      case "table": {
        const rows = await Promise.all(children.map(async (row) => new TableRow({
          tableHeader: !!row.content?.every((cell) => cell.type === "tableHeader"),
          children: await Promise.all((row.content ?? []).map(async (cell) => {
            const blocks = (await Promise.all((cell.content ?? []).map((child) => block(child)))).flat();
            return new TableCell({
              children: blocks.length ? blocks : [new Paragraph("")],
              ...(cell.type === "tableHeader" ? { shading: { fill: "F1F5F9" } } : {}),
              ...(Number(cell.attrs?.colspan) > 1 ? { columnSpan: Number(cell.attrs?.colspan) } : {}),
              ...(Number(cell.attrs?.rowspan) > 1 ? { rowSpan: Number(cell.attrs?.rowspan) } : {}),
            });
          })),
        })));
        return rows.length ? [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })] : [];
      }
      default:
        return [await paragraph()];
    }
  };

  const children = (await Promise.all((json.content ?? []).map((node) => block(node)))).flat();
  return Packer.toBlob(new Document({
    title,
    numbering: { config: numbering },
    styles: {
      default: {
        document: { run: { font: "Aptos", size: 22, color: "182033" }, paragraph: { spacing: { after: 120 } } },
      },
    },
    sections: [{ children: children.length ? children : [new Paragraph("")] }],
  }));
}
