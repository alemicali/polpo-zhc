import { useEffect, useId, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { TextSelection, type EditorState } from "@tiptap/pm/state";
import { nanoid } from "nanoid";
import {
  Bold, ChevronDown, Code, Eye, FileImage, Italic, Link2, List, ListChecks, ListOrdered,
  MessageSquare, Minus, MoreHorizontal, PanelLeft, Quote, Redo2, SquareCode, Strikethrough, Table2, Type, Underline, Undo2,
  Pencil, Sparkles, TextAlignStart, Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { embeddedDocImage } from "./artifact-doc-assets";
import { blankDocContent, DocEmptyHints } from "./artifact-doc-empty";
import { artifactDocExtensions, artifactDocUrl, docFontFamilies } from "./artifact-doc-format";
import { ArtifactDocMarkdown } from "./artifact-doc-preview";
import { DocChoiceEditContext } from "./artifact-doc-choice-context";
import { DocChoicePicker } from "./artifact-doc-choice-picker";
import { encodeDocComment } from "./artifact-doc-comments";
import { encodeDocChoice, readChoiceDefinitions, updateChoiceDefinition, type DocChoiceDefinition } from "./artifact-doc-choices";
import { DocTabNavigation, type DocTabAction } from "./artifact-doc-tab-navigation";
import { newDocTab, readDocTabs, writeDocTabs, type ArtifactDocTab } from "./artifact-doc-tabs";

const headingLevels = [1, 2, 3, 4, 5, 6] as const;
const fontLabels = { sans: "Sans serif", serif: "Serif", mono: "Monospace" };

const docScroll = "min-h-0 min-w-0 flex-1 overflow-y-auto px-5 pb-20 pt-16 sm:px-8";
const docColumn = "mx-auto w-full max-w-[672px]";
const docTypography = [
  "min-h-[45vh] break-words text-base leading-6 outline-none",
  "[&_p]:mt-0 [&_p]:mb-[0.6em] [&_strong]:font-semibold [&_h1:first-child]:mt-0 [&_h1]:mb-2 [&_h1]:mt-7 [&_h1]:font-serif [&_h1]:text-[32px] [&_h1]:leading-[1.2] [&_h1]:font-normal",
  "[&_[data-doc-placeholder]]:relative [&_[data-doc-placeholder]::before]:pointer-events-none [&_[data-doc-placeholder]::before]:absolute [&_[data-doc-placeholder]::before]:text-neutral-500 [&_[data-doc-placeholder]::before]:content-[attr(data-doc-placeholder)]",
  "[&_h2]:mb-[0.5em] [&_h2]:mt-[1.6em] [&_h2]:font-serif [&_h2]:text-[22px] [&_h2]:leading-[1.3] [&_h2]:font-normal",
  "[&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-xl [&_h3]:font-semibold",
  "[&_h4]:my-2 [&_h4]:text-lg [&_h4]:font-semibold [&_h5]:my-2 [&_h5]:font-semibold [&_h6]:my-2 [&_h6]:font-semibold",
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1 [&_li>p]:my-0",
  "[&_ul[data-type=taskList]]:list-none [&_li[data-type=taskItem]]:flex [&_li[data-type=taskItem]]:gap-2",
  "[&_a]:text-primary [&_a]:underline [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40",
  "[&_[data-alert]::before]:content-[attr(data-alert)] [&_[data-alert]::before]:block [&_[data-alert]::before]:font-semibold",
  "[&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_hr]:my-6 [&_pre]:my-4 [&_pre]:overflow-auto",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.88em]",
  "[&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4 [&_pre_code]:px-0",
  "[&_details]:my-3 [&_details]:rounded-md [&_details]:border [&_details]:p-3 [&_summary]:cursor-pointer [&_summary]:font-medium",
  "[&_[data-polpo-doc-font=sans]]:font-sans [&_[data-polpo-doc-font=serif]]:font-serif [&_[data-polpo-doc-font=mono]]:font-mono",
  "[&_video]:my-4 [&_video]:max-h-130 [&_video]:w-full [&_video]:rounded-md [&_video]:bg-black",
  "[&_img]:inline-block [&_img]:max-h-130 [&_img]:max-w-full [&_img]:rounded-md",
  "[&_.tableWrapper]:overflow-x-auto [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse",
  "[&_td]:min-w-16 [&_td]:border [&_td]:border-border [&_td]:p-2 [&_td]:align-top",
  "[&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:p-2 [&_th]:text-left",
  "[&_.selectedCell]:bg-primary/15 [&_.ProseMirror-selectednode]:outline-2 [&_.ProseMirror-selectednode]:outline-primary",
].join(" ");

interface DocInsertion {
  kind: "link" | "image" | "video";
  url: string;
  label: string;
  error?: string;
}

function commentDraft({ doc, selection }: EditorState) {
  const quote = doc.textBetween(selection.from, selection.to, "\n").trim();
  const length = selection.to - selection.from;
  return {
    position: selection.to, body: "", quote: quote.slice(0, 1000) || undefined,
    ...(length <= 3000 && quote.length <= 1000 ? { length } : {}),
  };
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

interface DocEditorProps {
  content: string;
  onChange: (content: string) => void;
  instanceName?: string;
  onAskAssistant?: (selection?: string) => void;
}

interface ArtifactDocEditorProps extends DocEditorProps {
  readOnly?: boolean;
}

export function ArtifactDocEditor({ content, onChange, readOnly = false, instanceName = "Polpo", onAskAssistant }: ArtifactDocEditorProps) {
  const book = useMemo(() => readDocTabs(content), [content]);
  const choices = useMemo(() => readChoiceDefinitions(content), [content]);
  const [activeId, setActiveId] = useState(book.tabs[0].id);
  const [tabsOpen, setTabsOpen] = useState(book.tabs.length > 1);
  const [mode, setMode] = useState<"editing" | "reading">("editing");
  const [tabDialog, setTabDialog] = useState<{ action: "rename" | "delete"; tab: ArtifactDocTab; title: string } | null>(null);
  const sidebarId = useId();
  const activeTab = book.tabs.find((tab) => tab.id === activeId) ?? book.tabs[0];
  const editing = !readOnly && mode === "editing";

  function updateTab(tabId: string, patch: Partial<Pick<ArtifactDocTab, "title" | "content">>) {
    onChange(writeDocTabs({
      ...book,
      tabs: book.tabs.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab),
    }));
  }

  function addTab(template?: ArtifactDocTab) {
    const tab = newDocTab(book.tabs, template);
    const tabs = [...book.tabs];
    const index = template ? tabs.findIndex((entry) => entry.id === template.id) + 1 : tabs.length;
    tabs.splice(index, 0, tab);
    setTabsOpen(true);
    setActiveId(tab.id);
    setMode("editing");
    onChange(writeDocTabs({ ...book, tabs }));
  }

  function tabAction(action: DocTabAction, tab: ArtifactDocTab) {
    if (action === "duplicate") {
      addTab(tab);
      return;
    }
    if (action === "rename" || action === "delete") {
      setTabDialog({ action, tab, title: tab.title });
      return;
    }
    const tabs = [...book.tabs];
    const current = tabs.findIndex((entry) => entry.id === tab.id);
    const next = current + (action === "earlier" ? -1 : 1);
    if (current < 0 || next < 0 || next >= tabs.length) return;
    [tabs[current], tabs[next]] = [tabs[next], tabs[current]];
    onChange(writeDocTabs({ ...book, tabs }));
  }

  function confirmTabAction() {
    if (!tabDialog) return;
    if (tabDialog.action === "rename") {
      if (!tabDialog.title.trim()) return;
      updateTab(tabDialog.tab.id, { title: tabDialog.title });
    } else if (book.tabs.length > 1) {
      const index = book.tabs.findIndex((tab) => tab.id === tabDialog.tab.id);
      if (index < 0) return;
      const tabs = book.tabs.filter((tab) => tab.id !== tabDialog.tab.id);
      if (activeTab.id === tabDialog.tab.id) setActiveId(tabs[Math.min(index, tabs.length - 1)].id);
      onChange(writeDocTabs({ ...book, tabs }));
    }
    setTabDialog(null);
  }

  return (
    <div className="artifact-doc-surface @container relative isolate flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex items-center justify-between gap-2 px-3">
        <div role="group" aria-label="Document actions" className="pointer-events-auto">
          <Button type="button" size="icon" variant={tabsOpen ? "secondary" : "outline"} aria-controls={sidebarId}
            className="h-9 w-[34px] shadow-sm" aria-label="Tabs" title={activeTab.title} aria-expanded={tabsOpen} onClick={() => setTabsOpen((open) => !open)}>
            <TextAlignStart />
          </Button>
        </div>
        {!readOnly && <div role="group" aria-label="View options" className="pointer-events-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="sm" variant="outline" className="h-9 min-w-[100px] shadow-sm" aria-label={mode === "editing" ? "Editing, mode" : "Reading, mode"}>
                {mode === "editing" ? <Pencil /> : <Eye />} {mode === "editing" ? "Editing" : "Reading"} <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="artifact-doc-surface">
              <DropdownMenuItem onSelect={() => setMode("editing")}><Pencil /> Editing</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setMode("reading")}><Eye /> Reading</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>}
      </div>
      <div className="relative flex min-h-0 flex-1">
        <aside id={sidebarId} hidden={!tabsOpen} className="artifact-doc-tab-sidebar absolute z-10 overflow-auto">
          <DocTabNavigation
            tabs={book.tabs}
            activeId={activeTab.id}
            onSelect={setActiveId}
            onAdd={editing ? () => addTab() : undefined}
            onAction={editing ? tabAction : undefined}
          />
        </aside>
        <div className="min-h-0 min-w-0 flex-1">
          {editing ? (
            <DocChoiceEditContext.Provider value={(definition) => onChange(writeDocTabs({
              ...book,
              tabs: book.tabs.map((tab) => ({ ...tab, content: updateChoiceDefinition(tab.content, definition) })),
            }))}>
              <DocTabEditor key={activeTab.id} content={activeTab.content} choices={choices} instanceName={instanceName}
                onAskAssistant={onAskAssistant} onChange={(text) => updateTab(activeTab.id, { content: text })} />
            </DocChoiceEditContext.Provider>
          ) : (
            <div className={`h-full ${docScroll}`}>
              <article className={`${docColumn} ${docTypography}`}>
                {activeTab.content ? <ArtifactDocMarkdown content={activeTab.content} /> : <p className="text-muted-foreground">This tab is empty.</p>}
              </article>
            </div>
          )}
        </div>
      </div>
      <Dialog open={tabDialog !== null} onOpenChange={(open) => { if (!open) setTabDialog(null); }}>
        {tabDialog && (
          <DialogContent className="artifact-doc-surface">
            <DialogHeader>
              <DialogTitle>{tabDialog.action === "rename" ? "Rename tab" : "Delete tab"}</DialogTitle>
              <DialogDescription>
                {tabDialog.action === "rename" ? "This name appears in the tab list." : `Remove “${tabDialog.tab.title}” from this document?`}
              </DialogDescription>
            </DialogHeader>
            <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); confirmTabAction(); }}>
              {tabDialog.action === "rename" && (
                <label className="block space-y-1 text-sm">
                  <span>Tab name</span>
                  <Input maxLength={100} autoFocus required value={tabDialog.title}
                    onChange={(event) => setTabDialog({ ...tabDialog, title: event.target.value })} />
                </label>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setTabDialog(null)}>Cancel</Button>
                <Button type="submit" variant={tabDialog.action === "delete" ? "destructive" : "default"}>
                  {tabDialog.action === "rename" ? "Rename" : "Delete"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function DocTabEditor({ content, onChange, choices, instanceName = "Polpo", onAskAssistant }: DocEditorProps & { choices: DocChoiceDefinition[] }) {
  const emitted = useRef(content);
  const hasAssistant = !!onAskAssistant;
  const extensions = useMemo(() => [
    ...artifactDocExtensions,
    DocEmptyHints.configure({ canAsk: hasAssistant, instanceName }),
  ], [hasAssistant, instanceName]);
  const imageReader = useRef<FileReader | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [insertion, setInsertion] = useState<DocInsertion | null>(null);
  const [comment, setComment] = useState<{ position: number; body: string; quote?: string; length?: number } | null>(null);
  const [dropdown, setDropdown] = useState<{ title: string; body: string; position?: number } | null>(null);
  const editor = useEditor({
    extensions,
    content: content.trim() ? content : blankDocContent,
    contentType: content.trim() ? "markdown" : "json",
    shouldRerenderOnTransaction: false,
    editorProps: {
      handleKeyDown: (view, event) => {
        const { doc, selection } = view.state;
        if (event.key.toLowerCase() === "m" && (event.metaKey || event.ctrlKey) && event.altKey) {
          event.preventDefault();
          setComment(commentDraft(view.state));
          return true;
        }
        if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey) return false;
        const title = doc.firstChild;
        if (!selection.empty || title?.type.name !== "heading" || title.attrs.level !== 1) return false;
        const block = selection.$from.index(0);
        const bodyIsParagraph = doc.maybeChild(1)?.type.name === "paragraph";
        if (!bodyIsParagraph || (event.shiftKey ? block !== 1 : block !== 0)) return false;
        event.preventDefault();
        view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, event.shiftKey ? 1 : title.nodeSize + 1)).scrollIntoView());
        return true;
      },
      handleDoubleClickOn: (_view, _pos, node, nodePos, _event, direct) => {
        if (!direct || node.type.name !== "docDropdown") return false;
        setDropdown({ title: String(node.attrs.title), body: String(node.attrs.body), position: nodePos });
        return true;
      },
      attributes: {
        "aria-label": "Document",
        "aria-multiline": "true",
        role: "textbox",
        class: docTypography,
      },
    },
    onUpdate: ({ editor }) => {
      const markdown = editor.isEmpty ? "" : editor.getMarkdown();
      emitted.current = markdown;
      onChange(markdown);
    },
  }, [hasAssistant, instanceName]);

  useEffect(() => {
    if (!editor || content === emitted.current) return;
    emitted.current = content;
    editor.commands.setContent(content.trim() ? content : blankDocContent, {
      contentType: content.trim() ? "markdown" : "json",
      emitUpdate: false,
    });
  }, [content, editor]);

  const format = useEditorState({
    editor,
    selector: ({ editor: active }) => active && ({
      heading: headingLevels.find((level) => active.isActive("heading", { level })) ?? 0,
      bold: active.isActive("bold"),
      italic: active.isActive("italic"),
      strike: active.isActive("strike"),
      underline: active.isActive("underline"),
      font: (active.getAttributes("docFont").family as string | undefined) ?? "default",
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

  const outline = useEditorState({
    editor,
    selector: ({ editor: active }) => {
      const headings: { position: number; level: number; title: string }[] = [];
      if (!active) return headings;
      active.state.doc.descendants((node, position) => {
        if (node.type.name === "heading") {
          const title = node.textContent.trim();
          if (title) headings.push({ position: position + 1, level: Number(node.attrs.level), title });
          return false;
        }
      });
      return headings;
    },
  }) ?? [];

  if (!editor || !format) return null;

  const hasAttachment = insertion ? !!embeddedDocImage(insertion.url) : false;

  function saveDropdown() {
    if (!editor || !dropdown?.title.trim()) return;
    const attrs = { title: dropdown.title.trim(), body: dropdown.body };
    const chain = editor.chain().focus();
    if (dropdown.position !== undefined && editor.state.doc.nodeAt(dropdown.position)?.type.name === "docDropdown") {
      chain.setNodeSelection(dropdown.position).updateAttributes("docDropdown", attrs).run();
    } else {
      chain.insertContent({ type: "docDropdown", attrs }).run();
    }
    setDropdown(null);
  }

  const saveInsertion = () => {
    if (!insertion) return;
    const url = insertion.url.trim();
    const { kind, label } = insertion;
    if (!artifactDocUrl(url, kind !== "link") && !(kind === "image" && embeddedDocImage(url))) {
      setInsertion({ ...insertion, error: kind === "link" ? "Enter an HTTP, HTTPS, or mailto link." : "Enter an HTTP or HTTPS media address." });
      return;
    }

    if (kind === "image") {
      editor.chain().focus().setImage({ src: url, alt: label }).run();
    } else if (kind === "video") {
      editor.chain().focus().insertContent({ type: "docVideo", attrs: { src: url, title: label.trim() || "Video" } }).run();
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

  function openComment() {
    if (!editor) return;
    setComment(commentDraft(editor.state));
  }

  function saveComment() {
    if (!editor || !comment?.body.trim()) return;
    const position = Math.min(comment.position, editor.state.doc.content.size);
    const payload = encodeDocComment({ id: nanoid(12), body: comment.body.trim(), quote: comment.quote, length: comment.length });
    if (editor.chain().focus().insertContentAt(position, { type: "docComment", attrs: { comment: payload } }).run()) {
      setComment(null);
    }
  }

  const askWithSelection = () => {
    if (!onAskAssistant) return;
    const { from, to, empty } = editor.state.selection;
    onAskAssistant(empty ? undefined : editor.state.doc.textBetween(from, to, "\n").trim() || undefined);
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <BubbleMenu editor={editor} updateDelay={80} options={{ placement: "top", offset: 7, flip: true, shift: true }}
        className="artifact-doc-surface z-30 flex max-w-[calc(100vw-1rem)] flex-wrap items-center rounded-lg border bg-background p-1 shadow-lg"
        role="group" aria-label="Document formatting">
        <div role="group" aria-label="Text format" className="flex items-center gap-0.5 border-r px-1.5">
          <select
            className="mr-1 h-8 rounded-control border border-border bg-background px-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring"
            aria-label="Paragraph style"
            value={format.heading}
            onChange={(event) => {
              const level = headingLevels.find((candidate) => String(candidate) === event.target.value);
              if (level) editor.chain().focus().setHeading({ level }).run();
              else editor.chain().focus().setParagraph().run();
            }}
          >
            <option value={0}>Normal text</option>
            {headingLevels.map((level) => <option key={level} value={level}>Heading {level}</option>)}
          </select>
          <FormatButton label="Bold" active={format.bold} onClick={() => editor.chain().focus().toggleBold().run()}><Bold /></FormatButton>
          <FormatButton label="Italic" active={format.italic} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic /></FormatButton>
          <FormatButton label="Underline" active={format.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline /></FormatButton>
          <FormatButton label="Strikethrough" active={format.strike} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough /></FormatButton>
        </div>

        <div role="group" aria-label="Lists" className="flex items-center gap-0.5 px-1.5">
          <FormatButton label="Bulleted list" active={format.bulletList} onClick={() => editor.chain().focus().toggleBulletList().run()}><List /></FormatButton>
          <FormatButton label="Numbered list" active={format.orderedList} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered /></FormatButton>
        </div>

        <FormatButton label="Comment on selection" onClick={openComment}><MessageSquare /></FormatButton>
        {onAskAssistant && <FormatButton label={`Ask ${instanceName} about selection`} onClick={askWithSelection}><Sparkles /></FormatButton>}
      </BubbleMenu>

      <div className="flex min-h-0 flex-1">
        {outlineOpen && (
          <nav id="doc-outline" aria-label="Document headings" className="max-h-38 shrink-0 overflow-auto border-b bg-background px-3 py-3 sm:max-h-none sm:w-52 sm:border-b-0 sm:border-r">
            <h2 className="mb-2 px-2 text-sm font-semibold">Outline</h2>
            {outline.length === 0 && <p className="px-2 text-xs leading-5 text-muted-foreground">Headings appear here as you add them.</p>}
            <ul className="grid gap-0.5">
              {outline.map(({ position, level, title }) => (
                <li key={position} style={{ paddingInlineStart: (level - 1) * 9 }}>
                  <button
                    type="button"
                    className="block w-full truncate rounded-control px-2 py-1.5 text-start text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    title={title}
                    onClick={() => editor.chain().focus().setTextSelection(position).scrollIntoView().run()}
                  >{title}</button>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className={docScroll}>
          <EditorContent editor={editor} className={`min-h-full ${docColumn}`}
            onClick={(event) => {
              if (event.target instanceof Element && event.target.closest("[data-doc-ask]")) onAskAssistant?.();
            }} />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 px-2">
        <div role="group" aria-label="Insert tools" className="pointer-events-auto mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-0.5 rounded-lg border bg-background px-1 py-px shadow-sm">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FormatButton label="Font"><Type /></FormatButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="artifact-doc-surface">
              <DropdownMenuLabel>Typeface</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={format.font} onValueChange={(value) => {
                if (value === "default") editor.chain().focus().unsetMark("docFont").run();
                else editor.chain().focus().setMark("docFont", { family: value }).run();
              }}>
                <DropdownMenuRadioItem value="default">Default</DropdownMenuRadioItem>
                {docFontFamilies.map((family) => <DropdownMenuRadioItem key={family} value={family}>{fontLabels[family]}</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FormatButton label="Table" active={format.table}><Table2 /></FormatButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="artifact-doc-surface">
              <DropdownMenuItem onSelect={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>Insert 3 × 3 table</DropdownMenuItem>
              {format.table && <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => editor.chain().focus().addRowBefore().run()}>Add row above</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => editor.chain().focus().addRowAfter().run()}>Add row below</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => editor.chain().focus().addColumnBefore().run()}>Add column to the left</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => editor.chain().focus().addColumnAfter().run()}>Add column to the right</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => editor.chain().focus().deleteRow().run()}>Delete row</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => editor.chain().focus().deleteColumn().run()}>Delete column</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => editor.chain().focus().deleteTable().run()}>Delete table</DropdownMenuItem>
              </>}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FormatButton label="Image or video"><FileImage /></FormatButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="artifact-doc-surface">
              <DropdownMenuItem onSelect={() => setInsertion({ kind: "image", url: "", label: "" })}><FileImage /> Image</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setInsertion({ kind: "video", url: "", label: "" })}><Video /> Video</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <FormatButton label="Checklist" active={format.taskList} onClick={() => editor.chain().focus().toggleTaskList().run()}><ListChecks /></FormatButton>
          <DocChoicePicker definitions={choices} onInsert={(definition) => {
            editor.chain().focus().insertContent({ type: "docChoice", attrs: { choice: encodeDocChoice(definition) } }).run();
          }} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="icon-sm" variant="ghost" aria-label="More document formatting" title="More document formatting"><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="artifact-doc-surface">
              <DropdownMenuItem onSelect={() => setInsertion({ kind: "link", url: editor.getAttributes("link").href ?? "", label: "" })}><Link2 />{format.link ? "Edit link" : "Link"}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => editor.chain().focus().setHorizontalRule().run()}><Minus /> Divider</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => editor.chain().focus().toggleCode().run()}><Code /> Inline code{format.code && " ✓"}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => editor.chain().focus().toggleCodeBlock().run()}><SquareCode /> Code block{format.codeBlock && " ✓"}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => editor.chain().focus().toggleBlockquote().run()}><Quote /> Quote{format.blockquote && " ✓"}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>Clear formatting</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setOutlineOpen((open) => !open)}><PanelLeft /> {outlineOpen ? "Hide outline" : "Show outline"}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!format.undo} onSelect={() => editor.chain().focus().undo().run()}><Undo2 /> Undo</DropdownMenuItem>
              <DropdownMenuItem disabled={!format.redo} onSelect={() => editor.chain().focus().redo().run()}><Redo2 /> Redo</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <FormatButton label="Comment" onClick={openComment}><MessageSquare /></FormatButton>
          {onAskAssistant && <Button type="button" size="sm" variant="secondary" className="ml-1 max-w-48 gap-1.5" onClick={askWithSelection}>
            <Sparkles className="size-3.5" /> <span className="truncate">Ask {instanceName}</span>
          </Button>}
        </div>
      </div>

      <Dialog open={comment !== null} onOpenChange={(open) => { if (!open) setComment(null); }}>
        {comment && <DialogContent className="artifact-doc-surface" onCloseAutoFocus={(event) => { event.preventDefault(); editor.commands.focus(); }}>
          <DialogHeader>
            <DialogTitle>New comment</DialogTitle>
            <DialogDescription>Attach a note to this part of the document.</DialogDescription>
          </DialogHeader>
          {comment.quote && <blockquote className="max-h-28 overflow-auto whitespace-pre-wrap break-words border-l-2 border-amber-400 pl-3 text-sm text-muted-foreground">{comment.quote}</blockquote>}
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); saveComment(); }}>
            <Textarea aria-label="Comment text" placeholder="Write a comment…" rows={4} autoFocus required maxLength={2000}
              value={comment.body} onChange={(event) => setComment({ ...comment, body: event.target.value })} />
            <DialogFooter><Button type="submit" disabled={!comment.body.trim()}>Add comment</Button></DialogFooter>
          </form>
        </DialogContent>}
      </Dialog>

      <Dialog open={dropdown !== null} onOpenChange={(open) => { if (!open) setDropdown(null); }}>
        {dropdown && (
          <DialogContent className="artifact-doc-surface" onCloseAutoFocus={(event) => { event.preventDefault(); editor.commands.focus(); }}>
            <DialogHeader>
              <DialogTitle>{dropdown.position === undefined ? "Insert dropdown" : "Edit dropdown"}</DialogTitle>
              <DialogDescription>Readers can expand the section to see its text.</DialogDescription>
            </DialogHeader>
            <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); saveDropdown(); }}>
              <label className="block space-y-1 text-sm">
                <span>Section title</span>
                <Input autoFocus required value={dropdown.title} onChange={(event) => setDropdown({ ...dropdown, title: event.target.value })} />
              </label>
              <label className="block space-y-1 text-sm">
                <span>Section text</span>
                <Textarea rows={4} value={dropdown.body} onChange={(event) => setDropdown({ ...dropdown, body: event.target.value })} />
              </label>
              <DialogFooter><Button type="submit">Apply</Button></DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={insertion !== null} onOpenChange={(open) => {
        if (!open) {
          imageReader.current?.abort();
          setInsertion(null);
        }
      }}>
        {insertion && (
          <DialogContent className="artifact-doc-surface" onCloseAutoFocus={(event) => { event.preventDefault(); editor.commands.focus(); }}>
            <DialogHeader>
              <DialogTitle>{insertion.kind === "image" ? "Insert image" : insertion.kind === "video" ? "Insert video" : format.link ? "Edit link" : "Insert link"}</DialogTitle>
              <DialogDescription>{insertion.kind === "image" ? "Use an image URL or select an image from your device." : insertion.kind === "video" ? "Use a direct link to an MP4 or other browser-playable video." : "Add the destination address."}</DialogDescription>
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
              {(insertion.kind !== "link" || (!format.link && !format.selected)) && (
                <label className="block space-y-1 text-sm">
                  <span>{insertion.kind === "image" ? "Alternative text" : insertion.kind === "video" ? "Video title" : "Link text"}</span>
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
