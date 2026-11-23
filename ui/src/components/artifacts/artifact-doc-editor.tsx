import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  Bold, Code, FileImage, Link2, List, ListChecks, ListOrdered, Minus, Quote,
  Redo2, SquareCode, Strikethrough, Table2, Undo2, Italic,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { embeddedDocImage } from "./artifact-doc-assets";
import { artifactDocExtensions, artifactDocUrl } from "./artifact-doc-format";

const headingLevels = [1, 2, 3, 4, 5, 6] as const;

const docTypography = [
  "min-h-[45vh] break-words text-[15px] leading-7 outline-none",
  "[&_p]:my-3 [&_h1]:mb-5 [&_h1]:mt-7 [&_h1]:font-heading [&_h1]:text-3xl [&_h1]:font-semibold",
  "[&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-2xl [&_h2]:font-semibold",
  "[&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-xl [&_h3]:font-semibold",
  "[&_h4]:my-2 [&_h4]:text-lg [&_h4]:font-semibold [&_h5]:my-2 [&_h5]:font-semibold [&_h6]:my-2 [&_h6]:font-semibold",
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li>p]:my-0",
  "[&_ul[data-type=taskList]]:list-none [&_li[data-type=taskItem]]:flex [&_li[data-type=taskItem]]:gap-2",
  "[&_a]:text-primary [&_a]:underline [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40",
  "[&_[data-alert]::before]:content-[attr(data-alert)] [&_[data-alert]::before]:block [&_[data-alert]::before]:font-semibold",
  "[&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_hr]:my-6 [&_pre]:my-4 [&_pre]:overflow-auto",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.88em]",
  "[&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4 [&_pre_code]:px-0",
  "[&_img]:inline-block [&_img]:max-h-130 [&_img]:max-w-full [&_img]:rounded-md",
  "[&_.tableWrapper]:overflow-x-auto [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse",
  "[&_td]:min-w-16 [&_td]:border [&_td]:border-border [&_td]:p-2 [&_td]:align-top",
  "[&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:p-2 [&_th]:text-left",
  "[&_.selectedCell]:bg-primary/15 [&_.ProseMirror-selectednode]:outline-2 [&_.ProseMirror-selectednode]:outline-primary",
].join(" ");

interface DocInsertion {
  kind: "link" | "image";
  url: string;
  label: string;
  error?: string;
}

function FormatButton({ label, active, ...props }: React.ComponentProps<typeof Button> & {
  label: string;
  active?: boolean;
}) {
  return (
    <Button
      {...props}
      type="button"
      size="icon-sm"
      variant={active ? "secondary" : "ghost"}
      aria-label={label}
      aria-pressed={active}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
    />
  );
}

export function ArtifactDocEditor({ content, onChange }: {
  content: string;
  onChange: (content: string) => void;
}) {
  const emitted = useRef(content);
  const imageReader = useRef<FileReader | null>(null);
  const [insertion, setInsertion] = useState<DocInsertion | null>(null);
  const editor = useEditor({
    extensions: artifactDocExtensions,
    content,
    contentType: "markdown",
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        "aria-label": "Document",
        "aria-multiline": "true",
        role: "textbox",
        class: docTypography,
      },
    },
    onUpdate: ({ editor }) => {
      const markdown = editor.getMarkdown();
      emitted.current = markdown;
      onChange(markdown);
    },
  });

  useEffect(() => {
    if (!editor || content === emitted.current) return;
    emitted.current = content;
    editor.commands.setContent(content, { contentType: "markdown", emitUpdate: false });
  }, [content, editor]);

  const format = useEditorState({
    editor,
    selector: ({ editor: active }) => active && ({
      heading: headingLevels.find((level) => active.isActive("heading", { level })) ?? 0,
      bold: active.isActive("bold"),
      italic: active.isActive("italic"),
      strike: active.isActive("strike"),
      code: active.isActive("code"),
      bulletList: active.isActive("bulletList"),
      orderedList: active.isActive("orderedList"),
      taskList: active.isActive("taskList"),
      blockquote: active.isActive("blockquote"),
      codeBlock: active.isActive("codeBlock"),
      link: active.isActive("link"),
      table: active.isActive("table"),
      selected: !active.state.selection.empty,
      undo: active.can().undo(),
      redo: active.can().redo(),
    }),
  });

  if (!editor || !format) return null;

  const hasAttachment = insertion ? !!embeddedDocImage(insertion.url) : false;

  const saveInsertion = () => {
    if (!insertion) return;
    const url = insertion.url.trim();
    const { kind, label } = insertion;
    if (!artifactDocUrl(url, kind === "image") && !(kind === "image" && embeddedDocImage(url))) {
      setInsertion({ ...insertion, error: kind === "image" ? "Enter an HTTP or HTTPS image address." : "Enter an HTTP, HTTPS, or mailto link." });
      return;
    }

    if (kind === "image") {
      editor.chain().focus().setImage({ src: url, alt: label }).run();
    } else if (format.link || format.selected) {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    } else {
      editor.chain().focus().insertContent({
        type: "text",
        text: label.trim() || url,
        marks: [{ type: "link", attrs: { href: url } }],
      }).run();
    }
    setInsertion(null);
  };

  const attachImage = (file: File | undefined) => {
    if (!file || !insertion) return;
    imageReader.current?.abort();
    if (!/^image\/(png|jpeg|gif|bmp|webp)$/.test(file.type) || file.size > 500_000) {
      setInsertion({ ...insertion, error: "Choose a PNG, JPEG, GIF, BMP, or WebP image up to 500 KB." });
      return;
    }
    const reader = new FileReader();
    imageReader.current = reader;
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      const url = reader.result;
      const label = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
      setInsertion((current) => current?.kind === "image" ? { ...current, url, label: current.label || label, error: undefined } : current);
    };
    reader.onerror = () => {
      setInsertion((current) => current?.kind === "image" ? { ...current, error: "The image could not be read." } : current);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/25">
      <div role="group" aria-label="Document formatting" className="flex flex-wrap items-center gap-x-0.5 gap-y-1 border-b bg-background px-2 py-1.5 sm:px-4">
        <FormatButton label="Undo" disabled={!format.undo} onClick={() => editor.chain().focus().undo().run()}><Undo2 /></FormatButton>
        <FormatButton label="Redo" disabled={!format.redo} onClick={() => editor.chain().focus().redo().run()}><Redo2 /></FormatButton>

        <select
          className="mx-1 h-8 rounded-control border border-border bg-background px-2 text-xs"
          aria-label="Paragraph style"
          value={format.heading}
          onChange={(event) => {
            const level = headingLevels.find((candidate) => String(candidate) === event.target.value);
            if (level) editor.chain().focus().setHeading({ level }).run();
            else editor.chain().focus().setParagraph().run();
          }}
        >
          <option value={0}>Paragraph</option>
          {headingLevels.map((level) => <option key={level} value={level}>Heading {level}</option>)}
        </select>

        <FormatButton label="Bold" active={format.bold} onClick={() => editor.chain().focus().toggleBold().run()}><Bold /></FormatButton>
        <FormatButton label="Italic" active={format.italic} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic /></FormatButton>
        <FormatButton label="Strikethrough" active={format.strike} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough /></FormatButton>
        <FormatButton label="Inline code" active={format.code} onClick={() => editor.chain().focus().toggleCode().run()}><Code /></FormatButton>
        <span className="mx-1 h-5 border-l" aria-hidden="true" />
        <FormatButton label="Bulleted list" active={format.bulletList} onClick={() => editor.chain().focus().toggleBulletList().run()}><List /></FormatButton>
        <FormatButton label="Numbered list" active={format.orderedList} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered /></FormatButton>
        <FormatButton label="Checklist" active={format.taskList} onClick={() => editor.chain().focus().toggleTaskList().run()}><ListChecks /></FormatButton>
        <FormatButton label="Quote" active={format.blockquote} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote /></FormatButton>
        <FormatButton label="Code block" active={format.codeBlock} onClick={() => editor.chain().focus().toggleCodeBlock().run()}><SquareCode /></FormatButton>
        <FormatButton label="Horizontal rule" onClick={() => editor.chain().focus().setHorizontalRule().run()}><Minus /></FormatButton>
        <span className="mx-1 h-5 border-l" aria-hidden="true" />
        <FormatButton label="Link" active={format.link} onClick={() => setInsertion({ kind: "link", url: editor.getAttributes("link").href ?? "", label: "" })}><Link2 /></FormatButton>
        <FormatButton label="Insert image" onClick={() => setInsertion({ kind: "image", url: "", label: "" })}><FileImage /></FormatButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="icon-sm" variant={format.table ? "secondary" : "ghost"} aria-label="Table" title="Table"><Table2 /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>Insert 3 × 3 table</DropdownMenuItem>
            {format.table && <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => editor.chain().focus().addRowAfter().run()}>Add row below</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => editor.chain().focus().addColumnAfter().run()}>Add column to the right</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => editor.chain().focus().deleteRow().run()}>Delete row</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => editor.chain().focus().deleteColumn().run()}>Delete column</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => editor.chain().focus().deleteTable().run()}>Delete table</DropdownMenuItem>
            </>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6 sm:py-6">
        <EditorContent
          editor={editor}
          className="mx-auto min-h-full w-full max-w-3xl rounded-lg border bg-background px-5 pb-10 pt-4 shadow-sm sm:px-12 sm:pt-8"
        />
      </div>

      <Dialog open={insertion !== null} onOpenChange={(open) => {
        if (!open) {
          imageReader.current?.abort();
          setInsertion(null);
        }
      }}>
        {insertion && (
          <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); editor.commands.focus(); }}>
            <DialogHeader>
              <DialogTitle>{insertion.kind === "image" ? "Insert image" : format.link ? "Edit link" : "Insert link"}</DialogTitle>
              <DialogDescription>{insertion.kind === "image" ? "Use an image URL or select an image from your device." : "Add the destination address."}</DialogDescription>
            </DialogHeader>
            <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); saveInsertion(); }}>
              <label className="block space-y-1 text-sm">
                <span>URL</span>
                <Input
                  autoFocus
                  required={!hasAttachment}
                  value={hasAttachment ? "" : insertion.url}
                  onChange={(event) => setInsertion({ ...insertion, url: event.target.value, error: undefined })}
                  placeholder={hasAttachment ? "Image attached" : "https://"}
                  inputMode="url"
                  aria-invalid={!!insertion.error}
                />
              </label>
              {insertion.kind === "image" && (
                <label className="block space-y-1 text-sm">
                  <span>Image file</span>
                  <Input
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/bmp,image/webp"
                    onChange={(event) => attachImage(event.target.files?.[0])}
                  />
                </label>
              )}
              {insertion.error && <p className="text-sm text-destructive" role="alert">{insertion.error}</p>}
              {(insertion.kind === "image" || (!format.link && !format.selected)) && (
                <label className="block space-y-1 text-sm">
                  <span>{insertion.kind === "image" ? "Alternative text" : "Link text"}</span>
                  <Input
                    value={insertion.label}
                    onChange={(event) => setInsertion({ ...insertion, label: event.target.value })}
                  />
                </label>
              )}
              <DialogFooter>
                {insertion.kind === "link" && format.link && (
                  <Button type="button" variant="outline" onClick={() => {
                    editor.chain().focus().extendMarkRange("link").unsetLink().run();
                    setInsertion(null);
                  }}>Remove link</Button>
                )}
                <Button type="submit">Apply</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
