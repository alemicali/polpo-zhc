import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  ChevronDown, ChevronRight, Download, File, FileCode, FileImage, FileJson, FileText, FileVideo, FileAudio, Folder, FolderOpen,
  Loader2, Code, Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl, ToggleGroupItem } from "@/components/ui/toggle-group";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import {
  ancestorsOf, buildFileTree, codeLanguage, fenced, formatSize, prettyJson, resolveSkillLink, skillFileKind, stripFrontmatter,
  type SkillFile, type SkillFileKind, type TreeNode,
} from "@/lib/skill-files";

// ── Tree ──

function FileIcon({ path, className }: { path: string; className?: string }) {
  const kind = skillFileKind(path);
  const Icon = kind === "markdown" || kind === "text" ? FileText
    : kind === "json" ? FileJson
    : kind === "code" ? FileCode
    : kind === "image" ? FileImage
    : kind === "video" ? FileVideo
    : kind === "audio" ? FileAudio
    : File;
  return <Icon className={cn("h-3.5 w-3.5 shrink-0", className)} />;
}

export function SkillFileTree({ files, selected, onSelect }: { files: SkillFile[]; selected: string; onSelect: (path: string) => void }) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  // folders open: the first level, and the way to the selected file
  const [open, setOpen] = useState<Set<string>>(() => new Set(tree.children.filter((c) => c.kind === "dir").map((c) => c.path)));
  useEffect(() => {
    const need = ancestorsOf(selected);
    setOpen((prev) => (need.every((p) => prev.has(p)) ? prev : new Set([...prev, ...need])));
  }, [selected]);
  const toggle = (path: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  const render = (node: TreeNode, depth: number): ReactNode => node.children.map((child) => {
    const pad = { paddingLeft: `calc(${depth} * 0.875rem + 0.5rem)` };
    if (child.kind === "dir") {
      const isOpen = open.has(child.path);
      return (
        <li key={`d:${child.path}`}>
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-1.5 rounded-xs py-1 pr-2 text-left text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            style={pad}
            aria-expanded={isOpen}
            onClick={() => toggle(child.path)}
          >
            {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
            {isOpen ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary/70" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-primary/70" />}
            <span className="min-w-0 flex-1 truncate">{child.name}</span>
          </button>
          {isOpen && <ul role="group">{render(child, depth + 1)}</ul>}
        </li>
      );
    }
    const active = child.path === selected;
    return (
      <li key={`f:${child.path}`}>
        <button
          type="button"
          className={cn(
            "flex w-full min-w-0 items-center gap-1.5 rounded-xs py-1 pr-2 text-left text-xs transition-colors",
            active ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
          )}
          style={{ paddingLeft: `calc(${depth} * 0.875rem + 1.25rem)` }}
          aria-current={active ? "true" : undefined}
          data-path={child.path}
          onClick={() => onSelect(child.path)}
        >
          <FileIcon path={child.path} className={active ? "text-primary" : "text-muted-foreground"} />
          <span className="min-w-0 flex-1 truncate font-mono">{child.name}</span>
          <span className="shrink-0 text-micro tabular-nums text-muted-foreground">{formatSize(child.size)}</span>
        </button>
      </li>
    );
  });

  return <ul role="tree" aria-label="Skill files" className="space-y-px">{render(tree, 0)}</ul>;
}

// ── Viewer ──

/** Render markdown whose relative links open files of the skill in place. */
function SkillMarkdown({ text, fromPath, known, onOpen }: { text: string; fromPath: string; known: Set<string>; onOpen: (path: string) => void }) {
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const components = useMemo<ComponentProps<typeof MessageResponse>["components"]>(() => ({
    a: ({ href, children, node: _node, ...rest }: ComponentProps<"a"> & { node?: unknown }) => {
      const target = resolveSkillLink(href, fromPath, known);
      if (target) {
        return (
          <a
            {...rest}
            href={`?file=${encodeURIComponent(target)}`}
            data-skill-file={target}
            className="text-primary underline underline-offset-2"
            onClick={(e) => { e.preventDefault(); onOpenRef.current(target); }}
          >
            {children}
          </a>
        );
      }
      return <a {...rest} href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">{children}</a>;
    },
  }), [fromPath, known]);
  // MessageResponse re-renders on children/mode only: key on what the links depend on
  return <MessageResponse key={`${fromPath}:${known.size}`} mode="static" components={components}>{text}</MessageResponse>;
}

const MAX_INLINE_BYTES = 2 * 1024 * 1024;
const TEXT_KINDS: SkillFileKind[] = ["markdown", "json", "code", "text"];

export interface SkillFileViewerProps {
  path: string;
  file?: SkillFile;
  files: SkillFile[];
  /** SKILL.md's body, already loaded (rendered without its frontmatter). */
  skillBody?: string;
  fileUrl: (path: string, opts?: { download?: boolean }) => string;
  readText: (path: string) => Promise<string>;
  onOpen: (path: string) => void;
}

/** One file of a skill: markdown rendered (raw on demand), code highlighted, JSON pretty, images, PDFs, else a download. */
export function SkillFileViewer({ path, file, files, skillBody, fileUrl, readText, onOpen }: SkillFileViewerProps) {
  const kind = skillFileKind(path);
  const known = useMemo(() => new Set(files.map((f) => f.path)), [files]);
  const [raw, setRaw] = useState(false);
  const [loaded, setLoaded] = useState<{ path: string; text?: string; error?: string } | null>(null);
  const isText = TEXT_KINDS.includes(kind);
  const tooBig = (file?.size ?? 0) > MAX_INLINE_BYTES;
  const useBody = path === "SKILL.md" && !raw && skillBody !== undefined;
  const needsText = isText && !tooBig && !useBody;

  useEffect(() => { setRaw(false); }, [path]);
  useEffect(() => {
    if (!needsText || loaded?.path === path) return;
    let cancelled = false;
    readText(path)
      .then((text) => { if (!cancelled) setLoaded({ path, text }); })
      .catch((err: unknown) => { if (!cancelled) setLoaded({ path, error: err instanceof Error ? err.message : "Could not read the file" }); });
    return () => { cancelled = true; };
  }, [needsText, path, readText, loaded?.path]);

  const text = loaded?.path === path ? loaded.text : undefined;
  const error = loaded?.path === path ? loaded.error : undefined;
  const download = (
    <Button variant="outline" size="sm" className="h-7" asChild>
      <a href={fileUrl(path, { download: true })} download aria-label={`Download ${path}`}>
        <Download className="h-3.5 w-3.5 mr-1.5" /> Download
      </a>
    </Button>
  );

  let body: ReactNode;
  if (useBody) {
    body = skillBody
      ? <SkillMarkdown text={skillBody} fromPath="SKILL.md" known={known} onOpen={onOpen} />
      : <p className="text-sm italic text-muted-foreground">This skill has no instructions</p>;
  } else if (tooBig && isText) {
    body = <p className="text-sm text-muted-foreground">This file is {formatSize(file!.size)}: download it to read it.</p>;
  } else if (isText) {
    if (error) body = <p className="text-sm text-destructive">{error}</p>;
    else if (text === undefined) body = <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
    else if (kind === "markdown" && !raw) body = <SkillMarkdown text={path === "SKILL.md" ? stripFrontmatter(text) : text} fromPath={path} known={known} onOpen={onOpen} />;
    else if (kind === "markdown") body = <MessageResponse mode="static">{fenced(text, "markdown")}</MessageResponse>;
    else if (kind === "json") body = <MessageResponse mode="static">{fenced(prettyJson(text), "json")}</MessageResponse>;
    else if (kind === "code") body = <MessageResponse mode="static">{fenced(text, codeLanguage(path))}</MessageResponse>;
    else body = <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground/90">{text}</pre>;
  } else if (kind === "image") {
    body = <div className="flex justify-center rounded-control bg-muted/20 p-4"><img src={fileUrl(path)} alt={path} className="max-h-[70vh] max-w-full object-contain" /></div>;
  } else if (kind === "pdf") {
    body = <iframe src={fileUrl(path)} title={path} className="h-[75vh] w-full rounded-control border border-border/40" />;
  } else if (kind === "audio") {
    body = <audio controls src={fileUrl(path)} className="w-full" />;
  } else if (kind === "video") {
    body = <video controls src={fileUrl(path)} className="max-h-[70vh] w-full" />;
  } else {
    body = (
      <div className="flex flex-col items-center gap-3 py-10 text-muted-foreground">
        <File className="h-10 w-10" />
        <p className="text-sm">No preview for this file type</p>
        {download}
      </div>
    );
  }

  return (
    <section aria-label={path} className="flex min-w-0 flex-col rounded-lg border border-border/40 bg-card/80">
      <header className="flex min-w-0 items-center gap-2 border-b border-border/40 px-4 py-2">
        <FileIcon path={path} className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>{path}</span>
        {file && <span className="shrink-0 text-micro tabular-nums text-muted-foreground">{formatSize(file.size)}</span>}
        {kind === "markdown" && (
          <SegmentedControl size="sm" aria-label="Markdown view" value={raw ? "raw" : "rendered"} onValueChange={(v) => setRaw(v === "raw")}>
            <ToggleGroupItem value="rendered" aria-label="Rendered"><Eye className="h-3.5 w-3.5" /></ToggleGroupItem>
            <ToggleGroupItem value="raw" aria-label="Raw"><Code className="h-3.5 w-3.5" /></ToggleGroupItem>
          </SegmentedControl>
        )}
        {download}
      </header>
      <div className="min-w-0 p-6" data-testid="skill-file-view" data-kind={kind}>{body}</div>
    </section>
  );
}
