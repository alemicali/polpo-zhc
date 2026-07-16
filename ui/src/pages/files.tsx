"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Folder,
  File,
  FileText,
  FileCode2,
  FileImage,
  FileAudio,
  FileVideo,
  FileBadge,
  ChevronRight,
  ArrowUp,
  Home,
  Download,
  Eye,
  RefreshCw,
  LayoutGrid,
  LayoutList,
  Search,
  HardDrive,
  Loader2,
  FolderOpen,
  ChevronDown,
  Upload,
  FolderUp,
  FolderPlus,
  Pencil,
  Trash2,
  Copy,
  Play,
  Music,
  LayoutPanelLeft,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  useFilePreview,
  FilePreviewDialog,
  fileReadUrl,
  mimeFromPath,
  previewCategory,
} from "@/components/shared/file-preview";
import { cn } from "@/lib/utils";
import { config } from "@/lib/config";
import { toast } from "sonner";
import { useEvents } from "@polpo-ai/react";

// ── Types ──

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  mimeType?: string;
  modifiedAt?: string;
}

interface RootDir {
  id: string;
  name: string;
  path: string;
  absolutePath: string;
  description: string;
  icon: string;
  totalFiles?: number;
  totalSize?: number;
}

interface UploadFile {
  file: globalThis.File;
  relativePath: string;
}

interface DroppedEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

interface DroppedFileEntry extends DroppedEntry {
  file: (success: (file: globalThis.File) => void, error?: (error: DOMException) => void) => void;
}

interface DroppedDirectoryReader {
  readEntries: (success: (entries: DroppedEntry[]) => void, error?: (error: DOMException) => void) => void;
}

interface DroppedDirectoryEntry extends DroppedEntry {
  createReader: () => DroppedDirectoryReader;
}

interface DirectoryDropItem {
  webkitGetAsEntry?: () => DroppedEntry | null;
}

type ViewMode = "list" | "grid" | "rows";
type SortKey = "name" | "type" | "size" | "modified";
type SortDir = "asc" | "desc";

// ── Helpers ──

const base = config.baseUrl || "";
const UPLOAD_BATCH_FILE_LIMIT = 100;
const UPLOAD_BATCH_BYTE_LIMIT = 32 * 1024 * 1024;

function uploadFile(file: globalThis.File, relativePath?: string): UploadFile {
  const webkitRelativePath = (file as globalThis.File & { webkitRelativePath?: string }).webkitRelativePath;
  return { file, relativePath: relativePath || webkitRelativePath || file.name };
}

function uploadBatches(files: UploadFile[]): UploadFile[][] {
  const batches: UploadFile[][] = [];
  let current: UploadFile[] = [];
  let currentBytes = 0;

  for (const entry of files) {
    if (
      current.length > 0 &&
      (current.length >= UPLOAD_BATCH_FILE_LIMIT || currentBytes + entry.file.size > UPLOAD_BATCH_BYTE_LIMIT)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += entry.file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function readDroppedFile(entry: DroppedFileEntry): Promise<globalThis.File> {
  return new Promise((resolveFile, reject) => entry.file(resolveFile, reject));
}

function readDroppedDirectory(reader: DroppedDirectoryReader): Promise<DroppedEntry[]> {
  return new Promise((resolveEntries, reject) => {
    const entries: DroppedEntry[] = [];
    const readNext = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolveEntries(entries);
          return;
        }
        entries.push(...batch);
        readNext();
      }, reject);
    };
    readNext();
  });
}

async function collectDroppedEntry(entry: DroppedEntry, parentPath = ""): Promise<UploadFile[]> {
  const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await readDroppedFile(entry as DroppedFileEntry);
    return [uploadFile(file, relativePath)];
  }
  if (!entry.isDirectory) return [];

  const children = await readDroppedDirectory((entry as DroppedDirectoryEntry).createReader());
  const nested = await Promise.all(children.map((child) => collectDroppedEntry(child, relativePath)));
  return nested.flat();
}

async function collectDroppedFiles(items: DataTransferItem[], fallbackFiles: globalThis.File[]): Promise<UploadFile[]> {
  const entries = items
    .map((item) => (item as unknown as DirectoryDropItem).webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is DroppedEntry => entry !== null);
  if (entries.length > 0) {
    return (await Promise.all(entries.map((entry) => collectDroppedEntry(entry)))).flat();
  }
  return fallbackFiles.map((file) => uploadFile(file));
}

function formatSize(bytes?: number): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fileIcon(entry: FileEntry) {
  if (entry.type === "directory") return Folder;
  const mime = entry.mimeType ?? mimeFromPath(entry.name);
  if (!mime) return File;
  if (mime.startsWith("image/")) return FileImage;
  if (mime.startsWith("audio/")) return FileAudio;
  if (mime.startsWith("video/")) return FileVideo;
  if (mime === "application/pdf") return FileBadge;
  if (
    mime.startsWith("text/x-") ||
    mime === "text/typescript" ||
    mime === "text/javascript" ||
    mime === "text/css" ||
    mime === "text/html" ||
    mime === "application/json" ||
    mime === "application/xml"
  ) return FileCode2;
  if (mime.startsWith("text/")) return FileText;
  return File;
}

function fileIconColor(entry: FileEntry): string {
  if (entry.type === "directory") return "text-sky-400";
  const mime = entry.mimeType ?? mimeFromPath(entry.name);
  if (!mime) return "text-muted-foreground/60";
  if (mime.startsWith("image/")) return "text-pink-400";
  if (mime.startsWith("audio/")) return "text-violet-400";
  if (mime.startsWith("video/")) return "text-red-400";
  if (mime === "application/pdf") return "text-orange-400";
  if (mime === "text/typescript" || mime === "text/javascript") return "text-blue-400";
  if (mime === "text/css") return "text-cyan-400";
  if (mime === "text/html") return "text-amber-400";
  if (mime === "application/json") return "text-emerald-400";
  if (mime.startsWith("text/x-")) return "text-teal-400";
  if (mime.startsWith("text/")) return "text-muted-foreground/80";
  return "text-muted-foreground/60";
}

function isPreviewableEntry(entry: FileEntry): boolean {
  if (entry.type === "directory") return false;
  const mime = entry.mimeType ?? mimeFromPath(entry.name);
  if (!mime) return false;
  const cat = previewCategory(mime);
  return cat !== "binary";
}

function sortEntries(entries: FileEntry[], sortKey: SortKey, sortDir: SortDir): FileEntry[] {
  const mult = sortDir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    switch (sortKey) {
      case "name": return mult * a.name.localeCompare(b.name);
      case "type": {
        const ma = a.mimeType ?? mimeFromPath(a.name) ?? "";
        const mb = b.mimeType ?? mimeFromPath(b.name) ?? "";
        return mult * ma.localeCompare(mb) || a.name.localeCompare(b.name);
      }
      case "size": return mult * ((a.size ?? 0) - (b.size ?? 0));
      case "modified": {
        const da = a.modifiedAt ? new Date(a.modifiedAt).getTime() : 0;
        const db = b.modifiedAt ? new Date(b.modifiedAt).getTime() : 0;
        return mult * (da - db);
      }
      default: return 0;
    }
  });
}

function entryPath(currentPath: string, name: string): string {
  return currentPath === "." ? name : `${currentPath}/${name}`;
}

// ── API helpers ──

async function apiUpload(destPath: string, files: UploadFile[], signal?: AbortSignal): Promise<{ count: number }> {
  const form = new FormData();
  form.set("path", destPath);
  for (const entry of files) {
    form.append("file", entry.file);
    form.append("relativePath", entry.relativePath);
  }
  const resp = await fetch(`${base}/api/v1/files/upload`, { method: "POST", body: form, signal });
  const json = await resp.json();
  if (!json.ok) throw new Error(json.error);
  return json.data;
}

async function apiMkdir(path: string): Promise<void> {
  const resp = await fetch(`${base}/api/v1/files/mkdir`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const json = await resp.json();
  if (!json.ok) throw new Error(json.error);
}

async function apiRename(path: string, newName: string): Promise<void> {
  const resp = await fetch(`${base}/api/v1/files/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, newName }),
  });
  const json = await resp.json();
  if (!json.ok) throw new Error(json.error);
}

async function apiDelete(path: string): Promise<void> {
  const resp = await fetch(`${base}/api/v1/files/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const json = await resp.json();
  if (!json.ok) throw new Error(json.error);
}

// ── Root selector component ──

// ── Finder-style grid: lazy thumbnails ─────────────────────────────────
//
// Tiles auto-fit ~144px columns. Real preview for images/videos; stylised
// fallback "paper card" for PDF / audio / code / generic. Lazy-loaded via
// IntersectionObserver — only tiles near the viewport request bytes.

/** Lazy mount helper — true once the element comes within `rootMargin`. */
function useInView(rootMargin = "200px"): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (inView) return; // sticky — once visible, stay loaded
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setInView(true);
            io.disconnect();
            return;
          }
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inView, rootMargin]);
  return [ref, inView];
}

const EXTENSION_PALETTE: Record<string, { ink: string; chip: string }> = {
  pdf:      { ink: "text-rose-500",    chip: "bg-rose-500/12 text-rose-500 border-rose-500/30" },
  doc:      { ink: "text-blue-500",    chip: "bg-blue-500/12 text-blue-500 border-blue-500/30" },
  docx:     { ink: "text-blue-500",    chip: "bg-blue-500/12 text-blue-500 border-blue-500/30" },
  xls:      { ink: "text-emerald-500", chip: "bg-emerald-500/12 text-emerald-500 border-emerald-500/30" },
  xlsx:     { ink: "text-emerald-500", chip: "bg-emerald-500/12 text-emerald-500 border-emerald-500/30" },
  zip:      { ink: "text-amber-500",   chip: "bg-amber-500/12 text-amber-500 border-amber-500/30" },
  tar:      { ink: "text-amber-500",   chip: "bg-amber-500/12 text-amber-500 border-amber-500/30" },
  gz:       { ink: "text-amber-500",   chip: "bg-amber-500/12 text-amber-500 border-amber-500/30" },
};

function extensionPalette(ext: string): { ink: string; chip: string } {
  return EXTENSION_PALETTE[ext.toLowerCase()] ?? {
    ink: "text-muted-foreground",
    chip: "bg-muted/40 text-muted-foreground border-border/60",
  };
}

/**
 * Stylised paper-card fallback used for non-previewable types.
 * The card has a top-right corner fold so it visually reads as a document.
 */
function PaperCard({ ext, accent }: { ext: string; accent: { ink: string; chip: string } }) {
  return (
    <div className="relative w-full h-full flex items-center justify-center">
      <div className="relative w-[64%] h-[80%] rounded-md bg-background/80 border border-border/60 shadow-[0_2px_6px_-2px_oklch(0.18_0.04_235_/_18%)] overflow-hidden">
        {/* corner fold */}
        <div className="absolute top-0 right-0 w-3.5 h-3.5">
          <div className="absolute inset-0 bg-muted/60" style={{ clipPath: "polygon(0 0, 100% 0, 100% 100%)" }} />
          <div className="absolute inset-0 border-l border-b border-border/70" style={{ clipPath: "polygon(0 100%, 0 0, 100% 100%)" }} />
        </div>
        {/* faux text lines */}
        <div className="absolute inset-x-2 top-2 space-y-1">
          <div className="h-0.5 w-3/4 bg-muted/60 rounded-full" />
          <div className="h-0.5 w-full bg-muted/40 rounded-full" />
          <div className="h-0.5 w-5/6 bg-muted/40 rounded-full" />
          <div className="h-0.5 w-2/3 bg-muted/40 rounded-full" />
        </div>
        {/* extension chip — center-bottom */}
        <div className="absolute inset-x-0 bottom-2 flex justify-center">
          <span className={cn(
            "px-1.5 py-px rounded font-mono text-[9px] font-bold uppercase tracking-wider border",
            accent.chip,
          )}>
            {ext || "file"}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Custom tide-pool folder — gradient SVG, more polished than the generic
 * lucide outline.
 */
function FolderGlyph({ open }: { open?: boolean }) {
  return (
    <div className="relative w-[68%] h-[68%]">
      <svg viewBox="0 0 64 56" className="w-full h-full drop-shadow-[0_3px_4px_oklch(0.2_0.04_235_/_18%)]">
        <defs>
          <linearGradient id="folder-back" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="oklch(0.78 0.07 200)" />
            <stop offset="100%" stopColor="oklch(0.62 0.115 205)" />
          </linearGradient>
          <linearGradient id="folder-front" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="oklch(0.86 0.05 205)" />
            <stop offset="100%" stopColor="oklch(0.7 0.1 205)" />
          </linearGradient>
        </defs>
        {/* back leaf */}
        <path d="M 4 10 Q 4 6 8 6 L 22 6 L 28 12 L 56 12 Q 60 12 60 16 L 60 50 Q 60 54 56 54 L 8 54 Q 4 54 4 50 Z"
              fill="url(#folder-back)" />
        {/* front pocket */}
        <path d={open
          ? "M 6 22 L 58 22 Q 62 22 60 26 L 54 50 Q 53 54 49 54 L 8 54 Q 4 54 4 50 L 4 26 Q 4 22 8 22 Z"
          : "M 4 22 L 60 22 L 60 50 Q 60 54 56 54 L 8 54 Q 4 54 4 50 Z"}
              fill="url(#folder-front)" />
      </svg>
    </div>
  );
}

/** Renders the right preview content for a file given its category. */
function FileThumb({
  entry,
  path,
  category,
  inView,
}: {
  entry: FileEntry;
  path: string;
  category: ReturnType<typeof previewCategory>;
  inView: boolean;
}) {
  const [errored, setErrored] = useState(false);
  const ext = (entry.name.split(".").pop() ?? "").toLowerCase();

  if (entry.type === "directory") {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <FolderGlyph />
      </div>
    );
  }

  if (category === "image" && !errored) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted/20 to-muted/40">
        {inView && (
          <img
            src={fileReadUrl(path)}
            alt={entry.name}
            loading="lazy"
            decoding="async"
            onError={() => setErrored(true)}
            className="w-full h-full object-cover"
          />
        )}
      </div>
    );
  }

  if (category === "video" && !errored) {
    return (
      <div className="relative w-full h-full bg-gradient-to-br from-muted/30 to-muted/50">
        {inView && (
          <video
            src={`${fileReadUrl(path)}#t=0.5`}
            preload="metadata"
            muted
            playsInline
            onError={() => setErrored(true)}
            className="w-full h-full object-cover"
          />
        )}
        {/* play overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/10 opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="h-8 w-8 rounded-full bg-background/85 backdrop-blur-sm flex items-center justify-center shadow-md ring-1 ring-border/40">
            <Play className="h-3.5 w-3.5 fill-foreground text-foreground translate-x-px" />
          </div>
        </div>
      </div>
    );
  }

  if (category === "audio") {
    return (
      <div className="relative w-full h-full flex items-center justify-center bg-gradient-to-br from-violet-500/8 to-fuchsia-500/8">
        {/* faux waveform */}
        <div className="flex items-end gap-px h-1/2 px-3">
          {[3, 6, 4, 8, 5, 9, 6, 4, 7, 3, 6, 5, 8, 4, 7].map((h, i) => (
            <span key={i} className="w-1 rounded-full bg-violet-500/60" style={{ height: `${h * 8}%` }} />
          ))}
        </div>
        <div className="absolute top-1.5 left-1.5 h-5 w-5 rounded-full bg-background/85 backdrop-blur-sm flex items-center justify-center ring-1 ring-violet-500/30">
          <Music className="h-2.5 w-2.5 text-violet-500" />
        </div>
      </div>
    );
  }

  // PDF / code / text / binary — paper-card with extension chip
  return <PaperCard ext={ext} accent={extensionPalette(ext)} />;
}

interface FileTileProps {
  entry: FileEntry;
  path: string;
  selected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: () => void;
}

/** Finder-style tile: square thumb + 2-line filename. */
function FileTile({ entry, path, selected, onClick, onDoubleClick, onContextMenu }: FileTileProps) {
  const [ref, inView] = useInView();
  const category = previewCategory(entry.mimeType ?? mimeFromPath(entry.name));
  const isPreviewable = entry.type === "file" && (category === "image" || category === "video");

  return (
    <div
      ref={ref}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className={cn(
        "group flex flex-col items-center gap-1.5 p-2 rounded-xl cursor-pointer select-none",
        "transition-[background-color,box-shadow,transform] duration-150",
        selected
          ? "bg-primary/10 ring-1 ring-primary/40 shadow-[0_0_20px_oklch(0.6_0.115_205_/_22%)]"
          : "hover:bg-accent/30",
      )}
    >
      <div
        className={cn(
          "relative aspect-square w-full overflow-hidden rounded-lg",
          "bg-card/60 border border-border/50",
          isPreviewable
            ? "shadow-[0_2px_6px_-2px_oklch(0.18_0.04_235_/_15%)]"
            : "",
          "transition-shadow duration-150 group-hover:shadow-[0_6px_14px_-4px_oklch(0.18_0.04_235_/_22%)]",
        )}
      >
        <FileThumb entry={entry} path={path} category={category} inView={inView} />
      </div>
      <span
        className="text-[11px] text-center leading-tight max-w-full font-medium px-0.5 line-clamp-2 break-words"
        title={entry.name}
      >
        {entry.name}
      </span>
      {entry.size != null && (
        <span className="text-[9px] text-muted-foreground/60 font-mono tabular-nums -mt-1">
          {formatSize(entry.size)}
        </span>
      )}
    </div>
  );
}

/**
 * Compact 44px thumbnail for the rows view — same renderer as FileTile but
 * with smaller fixed dimensions, no card wrapper, eager-loaded since rows
 * are short and there are typically fewer in viewport at once.
 */
function RowThumb({ entry, path }: { entry: FileEntry; path: string }) {
  const category = previewCategory(entry.mimeType ?? mimeFromPath(entry.name));
  return (
    <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-md border border-border/50 bg-card/60">
      <FileThumb entry={entry} path={path} category={category} inView />
    </div>
  );
}

function RootItem({
  root,
  active,
  onClick,
}: {
  root: RootDir;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = root.id === "polpo" ? HardDrive : FolderOpen;
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-left transition-colors text-sm",
        active
          ? "bg-primary/10 text-primary ring-1 ring-primary/20"
          : "hover:bg-accent/40 text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">{root.name}</div>
        <div className="text-[10px] opacity-60 truncate">{root.description}</div>
      </div>
    </button>
  );
}

// ── Breadcrumb ──

function Breadcrumb({
  segments,
  onNavigate,
  fullPath,
}: {
  segments: string[];
  onNavigate: (index: number) => void;
  fullPath: string;
}) {
  const copyFullPath = async () => {
    try {
      await navigator.clipboard.writeText(fullPath);
      toast.success("Full path copied");
    } catch {
      toast.error("Could not copy path");
    }
  };

  return (
    <nav className="group/path flex min-w-0 items-center gap-0.5 text-sm">
      <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
        <button
          onClick={() => onNavigate(-1)}
          className="shrink-0 p-1 rounded hover:bg-accent/40 transition-colors text-muted-foreground hover:text-foreground"
          aria-label="Workspace root"
        >
          <Home className="h-3.5 w-3.5" />
        </button>
        {segments.map((seg, i) => (
          <div key={i} className="flex items-center gap-0.5 min-w-0">
            <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0" />
            {i === segments.length - 1 ? (
              <span className="font-medium text-foreground truncate">{seg}</span>
            ) : (
              <button
                onClick={() => onNavigate(i)}
                className="truncate px-1 py-0.5 rounded hover:bg-accent/40 transition-colors text-muted-foreground hover:text-foreground"
              >
                {seg}
              </button>
            )}
          </div>
        ))}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => void copyFullPath()}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent/40 hover:text-foreground focus-visible:opacity-100 group-hover/path:opacity-100"
            aria-label="Copy full path"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Copy full path</TooltipContent>
      </Tooltip>
    </nav>
  );
}

// ── Inline rename input ──

function InlineRename({
  initialName,
  onConfirm,
  onCancel,
}: {
  initialName: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    // select name without extension
    const dot = initialName.lastIndexOf(".");
    inputRef.current?.setSelectionRange(0, dot > 0 ? dot : initialName.length);
  }, [initialName]);

  return (
    <form
      className="flex items-center gap-1 flex-1 min-w-0"
      onSubmit={e => { e.preventDefault(); if (value.trim() && value !== initialName) onConfirm(value.trim()); else onCancel(); }}
    >
      <Input
        ref={inputRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={onCancel}
        onKeyDown={e => { if (e.key === "Escape") onCancel(); }}
        className="h-6 text-sm px-1.5 py-0"
      />
    </form>
  );
}

// ── Main page ──

export function FilesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [roots, setRoots] = useState<RootDir[]>([]);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem("polpo-files-view") as ViewMode) || "list";
  });
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [renamingEntry, setRenamingEntry] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  /** Currently selected (highlighted) file name — single click selects, double click opens */
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const dragCounter = useRef(0);
  const { previewState, openPreview, closePreview } = useFilePreview();

  // Current path from URL
  const currentPath = searchParams.get("path") || ".";
  const highlightParam = searchParams.get("highlight");
  const activeRoot = roots.find(r => currentPath === r.path || (r.path !== "." && currentPath.startsWith(r.path + "/"))) || roots[0];
  const currentAbsolutePath = useMemo(() => {
    if (!activeRoot) return currentPath;
    const relativePath = activeRoot.path === "."
      ? (currentPath === "." ? "" : currentPath)
      : (currentPath === activeRoot.path ? "" : currentPath.slice(activeRoot.path.length + 1));
    if (!relativePath) return activeRoot.absolutePath;
    const separator = activeRoot.absolutePath.includes("\\") ? "\\" : "/";
    return `${activeRoot.absolutePath.replace(/[\\/]$/, "")}${separator}${relativePath.replace(/\//g, separator)}`;
  }, [activeRoot, currentPath]);

  // Path segments for breadcrumb
  const pathSegments = useMemo(() => {
    if (currentPath === "." || currentPath === "") return [];
    return currentPath.split("/").filter(Boolean);
  }, [currentPath]);

  // Persist view mode
  useEffect(() => {
    localStorage.setItem("polpo-files-view", viewMode);
  }, [viewMode]);

  // Fetch roots on mount
  useEffect(() => {
    fetch(`${base}/api/v1/files/roots`)
      .then(r => r.json())
      .then(json => {
        if (json.ok) {
          setRoots(json.data.roots);
          // If we're at "." and there's a workspace root, navigate there by default
          const wp = searchParams.get("path");
          if (!wp || wp === ".") {
            const workspace = json.data.roots.find((r: RootDir) => r.id === "workspace");
            if (workspace) setSearchParams({ path: workspace.path }, { replace: true });
          }
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch directory contents
  const fetchDir = useCallback(async (path: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const resp = await fetch(`${base}/api/v1/files/list?path=${encodeURIComponent(path)}`);
      const json = await resp.json();
      if (json.ok) {
        setEntries(json.data.entries);
      } else {
        setError(json.error || "Failed to list directory");
        setEntries([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDir(currentPath);
    // Clear selection only when directory changes.
    // Do not clear on highlight query cleanup, otherwise selection flashes then disappears.
    setSelectedEntry(null);
  }, [currentPath, fetchDir]);

  // Auto-select file from ?highlight= param (set by navigate_to tool with target="files")
  useEffect(() => {
    if (!highlightParam || entries.length === 0) return;
    // highlight param is the full path — extract the filename
    const filename = highlightParam.split("/").pop();
    if (filename && entries.some(e => e.name === filename)) {
      setSelectedEntry(filename);
      // Clean up the highlight param from URL so refreshing doesn't re-select
      const next = new URLSearchParams(searchParams);
      next.delete("highlight");
      setSearchParams(next, { replace: true });
    }
  }, [highlightParam, entries, searchParams, setSearchParams]);

  const refresh = useCallback(() => fetchDir(currentPath), [currentPath, fetchDir]);

  // ── Reactive file updates via SSE ──
  const FILE_EVENTS = useMemo(() => ["file:changed"], []);
  const { events: fileEvents } = useEvents(FILE_EVENTS, 1);
  const lastFileEventRef = useRef<string>("");
  useEffect(() => {
    if (fileEvents.length === 0) return;
    const latest = fileEvents[fileEvents.length - 1];
    // Skip if we already processed this event
    if (latest.id === lastFileEventRef.current) return;
    lastFileEventRef.current = latest.id;
    // Only refresh if the changed file is in the directory we're currently viewing
    const data = latest.data as { dir?: string; source?: string } | undefined;
    if (!data?.dir) { refresh(); return; }
    // Resolve both paths for comparison (server emits absolute paths, we use relative)
    // Simple check: refresh if dir ends with currentPath or currentPath ends with dir basename
    const normalizedDir = data.dir.replace(/\\/g, "/").replace(/\/$/, "");
    const normalizedCurrent = currentPath.replace(/\\/g, "/").replace(/\/$/, "");
    // If currentPath is "." (root), always refresh. Otherwise check if the dir matches.
    if (normalizedCurrent === "." || normalizedDir.endsWith(`/${normalizedCurrent}`) || normalizedDir === normalizedCurrent) {
      refresh();
    }
  }, [fileEvents, currentPath, refresh]);

  // Navigation
  const navigateTo = useCallback((path: string) => {
    setSearch("");
    setRenamingEntry(null);
    setSelectedEntry(null);
    setCreatingFolder(false);
    setSearchParams({ path });
  }, [setSearchParams]);

  const navigateUp = useCallback(() => {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    navigateTo(parts.length > 0 ? parts.join("/") : ".");
  }, [currentPath, navigateTo]);

  const handleBreadcrumbNav = useCallback((index: number) => {
    if (index === -1) { navigateTo("."); return; }
    const parts = currentPath.split("/").filter(Boolean);
    navigateTo(parts.slice(0, index + 1).join("/"));
  }, [currentPath, navigateTo]);

  /** Single click: select entry */
  const handleEntryClick = useCallback((entry: FileEntry) => {
    if (renamingEntry === entry.name) return;
    if (selectedEntry !== entry.name) {
      setSelectedEntry(entry.name);
    }
  }, [renamingEntry, selectedEntry]);

  /** Double click: open preview (files) or navigate into (directories) */
  const handleEntryDoubleClick = useCallback((entry: FileEntry) => {
    if (renamingEntry === entry.name) return;
    if (entry.type === "directory") {
      navigateTo(entryPath(currentPath, entry.name));
    } else {
      const mime = entry.mimeType ?? mimeFromPath(entry.name);
      openPreview({ label: entry.name, path: entryPath(currentPath, entry.name), mimeType: mime, size: entry.size });
    }
  }, [currentPath, navigateTo, openPreview, renamingEntry]);

  // ── Upload ──
  const handleUploadFiles = useCallback(async (files: UploadFile[]) => {
    if (files.length === 0) return;
    const controller = new AbortController();
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = controller;
    setUploading(true);
    const toastId = toast.loading(`Uploading 0 of ${files.length} files...`);
    let uploaded = 0;
    try {
      for (const batch of uploadBatches(files)) {
        const result = await apiUpload(currentPath, batch, controller.signal);
        uploaded += result.count;
        toast.loading(`Uploading ${uploaded} of ${files.length} files...`, { id: toastId });
      }
      toast.success(`Uploaded ${uploaded} file${uploaded !== 1 ? "s" : ""}`, { id: toastId });
      refresh();
    } catch (err) {
      if (controller.signal.aborted) {
        toast.info(uploaded > 0 ? `Upload stopped after ${uploaded} files` : "Upload stopped", { id: toastId });
        refresh();
      } else {
        const message = err instanceof Error ? err.message : "Upload failed";
        toast.error(uploaded > 0 ? `${message} (${uploaded} files uploaded)` : message, { id: toastId });
      }
    } finally {
      if (uploadAbortRef.current === controller) {
        uploadAbortRef.current = null;
        setUploading(false);
      }
    }
  }, [currentPath, refresh]);

  const cancelUpload = useCallback(() => {
    uploadAbortRef.current?.abort();
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) void handleUploadFiles(Array.from(files, (file) => uploadFile(file)));
    e.target.value = "";
  }, [handleUploadFiles]);

  const handleFolderInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) void handleUploadFiles(Array.from(files, (file) => uploadFile(file)));
    e.target.value = "";
  }, [handleUploadFiles]);

  // ── Drag & drop ──
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setDragging(false);
    const items = Array.from(e.dataTransfer.items);
    const fallbackFiles = Array.from(e.dataTransfer.files);
    void collectDroppedFiles(items, fallbackFiles)
      .then((files) => handleUploadFiles(files))
      .catch((error) => toast.error(error instanceof Error ? error.message : "Could not read dropped folder"));
  }, [handleUploadFiles]);

  // ── Create folder ──
  const handleCreateFolder = useCallback(async (name: string) => {
    setCreatingFolder(false);
    try {
      await apiMkdir(entryPath(currentPath, name));
      toast.success(`Created folder "${name}"`);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create folder");
    }
  }, [currentPath, refresh]);

  // ── Rename ──
  const handleRename = useCallback(async (entry: FileEntry, newName: string) => {
    setRenamingEntry(null);
    try {
      await apiRename(entryPath(currentPath, entry.name), newName);
      toast.success(`Renamed to "${newName}"`);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rename failed");
    }
  }, [currentPath, refresh]);

  // ── Delete ──
  const handleDelete = useCallback(async (entry: FileEntry) => {
    try {
      await apiDelete(entryPath(currentPath, entry.name));
      toast.success(`Deleted "${entry.name}"`);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }, [currentPath, refresh]);

  // Filter and sort
  const filtered = useMemo(() => {
    let items = entries;
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(e => e.name.toLowerCase().includes(q));
    }
    return sortEntries(items, sortKey, sortDir);
  }, [entries, search, sortKey, sortDir]);

  const dirCount = filtered.filter(e => e.type === "directory").length;
  const fileCount = filtered.filter(e => e.type === "file").length;

  // ── Render entry row (list view) ──
  const renderListEntry = (entry: FileEntry) => {
    const Icon = fileIcon(entry);
    const color = fileIconColor(entry);
    const canPreview = isPreviewableEntry(entry);
    const isRenaming = renamingEntry === entry.name;

    const isSelected = selectedEntry === entry.name;
    const row = (
      <div
        onClick={() => !isRenaming && handleEntryClick(entry)}
        onDoubleClick={() => !isRenaming && handleEntryDoubleClick(entry)}
        onContextMenu={() => setSelectedEntry(entry.name)}
        className={cn(
          "flex items-center gap-3 w-full px-3 py-2 text-left group cursor-pointer select-none",
          isSelected ? "bg-primary/10 hover:bg-primary/15" : "hover:bg-accent/30",
        )}
      >
        <Icon className={cn("h-4 w-4 shrink-0", color)} />
        {isRenaming ? (
          <InlineRename
            initialName={entry.name}
            onConfirm={name => handleRename(entry, name)}
            onCancel={() => setRenamingEntry(null)}
          />
        ) : (
          <>
            <span className="flex-1 min-w-0 text-sm truncate">
              {entry.name}
              {entry.type === "directory" && <span className="text-muted-foreground/40">/</span>}
            </span>
            <span className="text-[11px] text-muted-foreground/60 tabular-nums shrink-0 w-16 text-right hidden sm:block">
              {formatSize(entry.size)}
            </span>
            <span className="text-[11px] text-muted-foreground/50 shrink-0 w-20 text-right hidden lg:block">
              {formatDate(entry.modifiedAt)}
            </span>
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              {entry.type === "file" && canPreview && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={e => { e.stopPropagation(); const p = entryPath(currentPath, entry.name); const m = entry.mimeType ?? mimeFromPath(entry.name); openPreview({ label: entry.name, path: p, mimeType: m, size: entry.size }); }}>
                      <Eye className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">Preview</TooltipContent>
                </Tooltip>
              )}
              {entry.type === "file" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={e => { e.stopPropagation(); window.open(fileReadUrl(entryPath(currentPath, entry.name), true), "_blank"); }}>
                      <Download className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">Download</TooltipContent>
                </Tooltip>
              )}
            </div>
          </>
        )}
      </div>
    );

    return (
      <ContextMenu key={entry.name}>
        <ContextMenuTrigger asChild>
          {row}
        </ContextMenuTrigger>
        <ContextMenuContent>
          {entry.type === "directory" ? (
            <ContextMenuItem onSelect={() => navigateTo(entryPath(currentPath, entry.name))}>
              <FolderOpen className="h-3.5 w-3.5 mr-2" /> Open
            </ContextMenuItem>
          ) : (
            <>
              {canPreview && (
                <ContextMenuItem onSelect={() => { const p = entryPath(currentPath, entry.name); const m = entry.mimeType ?? mimeFromPath(entry.name); openPreview({ label: entry.name, path: p, mimeType: m, size: entry.size }); }}>
                  <Eye className="h-3.5 w-3.5 mr-2" /> Preview
                </ContextMenuItem>
              )}
              <ContextMenuItem onSelect={() => window.open(fileReadUrl(entryPath(currentPath, entry.name), true), "_blank")}>
                <Download className="h-3.5 w-3.5 mr-2" /> Download
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => { navigator.clipboard.writeText(entry.name); toast.success("Name copied"); }}>
            <Copy className="h-3.5 w-3.5 mr-2" /> Copy name
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setRenamingEntry(entry.name)}>
            <Pencil className="h-3.5 w-3.5 mr-2" /> Rename
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => handleDelete(entry)}>
            <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  // ── Render entry row (rows / list-with-thumbnail view) ──
  // List metadata layout (name, size, date, hover actions) but with a real
  // 48px thumbnail leading each row instead of a flat icon.
  const renderRowsEntry = (entry: FileEntry) => {
    const canPreview = isPreviewableEntry(entry);
    const isRenaming = renamingEntry === entry.name;
    const isSelected = selectedEntry === entry.name;
    const path = entryPath(currentPath, entry.name);

    const row = (
      <div
        onClick={() => !isRenaming && handleEntryClick(entry)}
        onDoubleClick={() => !isRenaming && handleEntryDoubleClick(entry)}
        onContextMenu={() => setSelectedEntry(entry.name)}
        className={cn(
          "flex items-center gap-3 w-full px-3 py-2.5 text-left group cursor-pointer select-none",
          isSelected ? "bg-primary/10 hover:bg-primary/15" : "hover:bg-accent/30",
        )}
      >
        <RowThumb entry={entry} path={path} />
        {isRenaming ? (
          <InlineRename
            initialName={entry.name}
            onConfirm={name => handleRename(entry, name)}
            onCancel={() => setRenamingEntry(null)}
          />
        ) : (
          <>
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate font-medium">
                {entry.name}
                {entry.type === "directory" && <span className="text-muted-foreground/40">/</span>}
              </div>
              {(entry.size != null || entry.modifiedAt) && (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60 mt-0.5">
                  {entry.size != null && <span className="tabular-nums">{formatSize(entry.size)}</span>}
                  {entry.size != null && entry.modifiedAt && <span className="opacity-50">·</span>}
                  {entry.modifiedAt && <span>{formatDate(entry.modifiedAt)}</span>}
                </div>
              )}
            </div>
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              {entry.type === "file" && canPreview && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={e => { e.stopPropagation(); const m = entry.mimeType ?? mimeFromPath(entry.name); openPreview({ label: entry.name, path, mimeType: m, size: entry.size }); }}>
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">Preview</TooltipContent>
                </Tooltip>
              )}
              {entry.type === "file" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={e => { e.stopPropagation(); window.open(fileReadUrl(path, true), "_blank"); }}>
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">Download</TooltipContent>
                </Tooltip>
              )}
            </div>
          </>
        )}
      </div>
    );

    return (
      <ContextMenu key={entry.name}>
        <ContextMenuTrigger asChild>
          {row}
        </ContextMenuTrigger>
        <ContextMenuContent>
          {entry.type === "directory" ? (
            <ContextMenuItem onSelect={() => navigateTo(path)}>
              <FolderOpen className="h-3.5 w-3.5 mr-2" /> Open
            </ContextMenuItem>
          ) : (
            <>
              {canPreview && (
                <ContextMenuItem onSelect={() => { const m = entry.mimeType ?? mimeFromPath(entry.name); openPreview({ label: entry.name, path, mimeType: m, size: entry.size }); }}>
                  <Eye className="h-3.5 w-3.5 mr-2" /> Preview
                </ContextMenuItem>
              )}
              <ContextMenuItem onSelect={() => window.open(fileReadUrl(path, true), "_blank")}>
                <Download className="h-3.5 w-3.5 mr-2" /> Download
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => { navigator.clipboard.writeText(entry.name); toast.success("Name copied"); }}>
            <Copy className="h-3.5 w-3.5 mr-2" /> Copy name
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setRenamingEntry(entry.name)}>
            <Pencil className="h-3.5 w-3.5 mr-2" /> Rename
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => handleDelete(entry)}>
            <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  // ── Render entry card (grid / Finder-style thumbnail view) ──
  const renderGridEntry = (entry: FileEntry) => {
    const canPreview = isPreviewableEntry(entry);
    const isSelectedGrid = selectedEntry === entry.name;
    const path = entryPath(currentPath, entry.name);

    return (
      <ContextMenu key={entry.name}>
        <ContextMenuTrigger asChild>
          <FileTile
            entry={entry}
            path={path}
            selected={isSelectedGrid}
            onClick={() => handleEntryClick(entry)}
            onDoubleClick={() => handleEntryDoubleClick(entry)}
            onContextMenu={() => setSelectedEntry(entry.name)}
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          {entry.type === "directory" ? (
            <ContextMenuItem onSelect={() => navigateTo(entryPath(currentPath, entry.name))}>
              <FolderOpen className="h-3.5 w-3.5 mr-2" /> Open
            </ContextMenuItem>
          ) : (
            <>
              {canPreview && (
                <ContextMenuItem onSelect={() => { const p = entryPath(currentPath, entry.name); const m = entry.mimeType ?? mimeFromPath(entry.name); openPreview({ label: entry.name, path: p, mimeType: m, size: entry.size }); }}>
                  <Eye className="h-3.5 w-3.5 mr-2" /> Preview
                </ContextMenuItem>
              )}
              <ContextMenuItem onSelect={() => window.open(fileReadUrl(entryPath(currentPath, entry.name), true), "_blank")}>
                <Download className="h-3.5 w-3.5 mr-2" /> Download
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => { navigator.clipboard.writeText(entry.name); toast.success("Name copied"); }}>
            <Copy className="h-3.5 w-3.5 mr-2" /> Copy name
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setRenamingEntry(entry.name)}>
            <Pencil className="h-3.5 w-3.5 mr-2" /> Rename
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => handleDelete(entry)}>
            <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 gap-0">
      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInputChange} />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFolderInputChange}
        {...({ webkitdirectory: "" } as Record<string, string>)}
      />

      {/* Top bar */}
      <div className="flex shrink-0 flex-col gap-2 px-1 pb-3 lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1">
          <Breadcrumb segments={pathSegments} onNavigate={handleBreadcrumbNav} fullPath={currentAbsolutePath} />
        </div>
        <div className="flex max-w-full shrink-0 items-center gap-1 overflow-x-auto scrollbar-none pb-0.5 lg:overflow-visible lg:pb-0">
          {/* Upload */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => uploading ? cancelUpload() : fileInputRef.current?.click()}
                aria-label={uploading ? "Cancel upload" : "Upload files"}
              >
                {uploading ? <X className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{uploading ? "Cancel upload" : "Upload files"}</TooltipContent>
          </Tooltip>

          {/* Upload folder */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => folderInputRef.current?.click()}
                disabled={uploading}
                aria-label="Upload folder"
              >
                <FolderUp className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Upload folder</TooltipContent>
          </Tooltip>

          {/* New folder */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCreatingFolder(true)}>
                <FolderPlus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New folder</TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-5 mx-1 shrink-0" />

          {/* Search */}
          <div className="relative shrink-0">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Filter..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-8 w-32 pl-7 text-sm lg:w-48"
            />
          </div>

          <Separator orientation="vertical" className="h-5 mx-1 shrink-0" />

          {/* Sort */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 shrink-0 text-xs gap-1">
                <ChevronDown className="h-3 w-3" />
                {sortKey}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              {(["name", "type", "size", "modified"] as SortKey[]).map(k => (
                <DropdownMenuItem
                  key={k}
                  onSelect={() => {
                    if (sortKey === k) setSortDir(d => d === "asc" ? "desc" : "asc");
                    else { setSortKey(k); setSortDir("asc"); }
                  }}
                  className="text-xs capitalize"
                >
                  {k} {sortKey === k && (sortDir === "asc" ? "\u2191" : "\u2193")}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* View toggle */}
          <div className="flex shrink-0 items-center rounded-md border">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant={viewMode === "list" ? "secondary" : "ghost"} size="icon" className="h-7 w-7 rounded-r-none rounded-l-md" onClick={() => setViewMode("list")}>
                  <LayoutList className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Compact list</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant={viewMode === "rows" ? "secondary" : "ghost"} size="icon" className="h-7 w-7 rounded-none border-x" onClick={() => setViewMode("rows")}>
                  <LayoutPanelLeft className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Rows with previews</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant={viewMode === "grid" ? "secondary" : "ghost"} size="icon" className="h-7 w-7 rounded-l-none rounded-r-md" onClick={() => setViewMode("grid")}>
                  <LayoutGrid className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Thumbnails</TooltipContent>
            </Tooltip>
          </div>

          {/* Back / Refresh */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={navigateUp} disabled={currentPath === "."}>
                <ArrowUp className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Up one level</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={refresh}>
                <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Refresh</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Main content: sidebar + file list */}
      <div className="flex flex-1 min-h-0 gap-0 border rounded-xl overflow-hidden bg-card/50">
        {/* Sidebar: roots */}
        <div
          className={cn(
            "shrink-0 border-r bg-muted/20 transition-all duration-200 overflow-hidden",
            sidebarCollapsed ? "w-0 border-r-0" : "w-48",
          )}
        >
          <div className="flex flex-col h-full">
            <div className="p-2 flex flex-col gap-1 flex-1">
              <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                Locations
              </div>
              {roots.map(root => (
                <RootItem
                  key={root.id}
                  root={root}
                  active={activeRoot?.id === root.id}
                  onClick={() => navigateTo(root.path === "." ? "." : root.path)}
                />
              ))}
            </div>
            {activeRoot && (activeRoot.totalFiles != null || activeRoot.totalSize != null) && (
              <div className="px-3 py-2 border-t border-border/30 text-[10px] text-muted-foreground/60 space-y-0.5">
                <div className="flex items-center justify-between">
                  <span>{(activeRoot.totalFiles ?? 0).toLocaleString()} files</span>
                  <span>{formatSize(activeRoot.totalSize)}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Toggle sidebar */}
        <button
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className="shrink-0 w-3 hover:bg-accent/40 transition-colors flex items-center justify-center group"
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 text-muted-foreground/30 group-hover:text-muted-foreground transition-transform",
              !sidebarCollapsed && "rotate-180",
            )}
          />
        </button>

        {/* File list area — drop zone */}
        <div
          className="flex-1 min-w-0 min-h-0 flex flex-col relative"
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {/* Drag overlay */}
          {dragging && (
            <div className="absolute inset-0 z-20 bg-primary/5 border-2 border-dashed border-primary/40 rounded flex items-center justify-center pointer-events-none">
              <div className="flex flex-col items-center gap-2 text-primary">
                <FolderUp className="h-8 w-8" />
                <span className="text-sm font-medium">Drop files or folders to upload</span>
              </div>
            </div>
          )}

          {/* Status bar */}
          <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-muted/10 text-[11px] text-muted-foreground shrink-0">
            <FolderOpen className="h-3 w-3" />
            <span>{dirCount} folder{dirCount !== 1 && "s"}, {fileCount} file{fileCount !== 1 && "s"}</span>
            {search && (
              <Badge variant="outline" className="text-[9px] h-4 ml-1">filtered</Badge>
            )}
          </div>

          {/* Entries — background context menu for empty space */}
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <ScrollArea className="flex-1 min-h-0">
                {loading ? (
                  <div className="flex items-center justify-center py-20">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : error ? (
                  <div className="flex flex-col items-center justify-center py-20 gap-2 text-muted-foreground">
                    <p className="text-sm">{error}</p>
                    <Button variant="outline" size="sm" onClick={refresh}>Retry</Button>
                  </div>
                ) : (
                  <>
                    {/* Create folder inline row */}
                    {creatingFolder && (
                      <div className="flex items-center gap-3 px-3 py-2 border-b border-border/30 bg-accent/10">
                        <FolderPlus className="h-4 w-4 text-sky-400 shrink-0" />
                        <InlineRename
                          initialName="New Folder"
                          onConfirm={handleCreateFolder}
                          onCancel={() => setCreatingFolder(false)}
                        />
                      </div>
                    )}

                    {filtered.length === 0 && !creatingFolder ? (
                      <div className="flex flex-col items-center justify-center py-20 gap-2 text-muted-foreground">
                        <Folder className="h-8 w-8 mb-2 opacity-30" />
                        <p className="text-sm">{search ? "No matching entries" : "Empty directory"}</p>
                        <p className="text-xs opacity-50">Drop files or folders here, or use an upload button</p>
                      </div>
                    ) : viewMode === "list" ? (
                      <div className="divide-y divide-border/30">
                        {filtered.map(renderListEntry)}
                      </div>
                    ) : viewMode === "rows" ? (
                      <div className="divide-y divide-border/20">
                        {filtered.map(renderRowsEntry)}
                      </div>
                    ) : (
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(144px,1fr))] gap-2 p-3">
                        {filtered.map(renderGridEntry)}
                      </div>
                    )}
                  </>
                )}
              </ScrollArea>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => fileInputRef.current?.click()}>
                <Upload className="h-3.5 w-3.5 mr-2" /> Upload files
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => folderInputRef.current?.click()}>
                <FolderUp className="h-3.5 w-3.5 mr-2" /> Upload folder
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => setCreatingFolder(true)}>
                <FolderPlus className="h-3.5 w-3.5 mr-2" /> New folder
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={refresh}>
                <RefreshCw className="h-3.5 w-3.5 mr-2" /> Refresh
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>
      </div>

      {/* File preview dialog */}
      <FilePreviewDialog preview={previewState} onClose={closePreview} />
    </div>
  );
}
