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
  Settings2,
  Loader2,
  FolderOpen,
  ChevronDown,
  Upload,
  FolderPlus,
  Pencil,
  Trash2,

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

type ViewMode = "list" | "grid";
type SortKey = "name" | "type" | "size" | "modified";
type SortDir = "asc" | "desc";

// ── Helpers ──

const base = config.baseUrl || "";

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

async function apiUpload(destPath: string, files: globalThis.File[]): Promise<{ count: number }> {
  const form = new FormData();
  form.set("path", destPath);
  for (const f of files) form.append("file", f);
  const resp = await fetch(`${base}/api/v1/files/upload`, { method: "POST", body: form });
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

function RootItem({
  root,
  active,
  onClick,
}: {
  root: RootDir;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = root.id === "polpo" ? Settings2 : root.id === "workspace" ? FolderOpen : HardDrive;
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
}: {
  segments: string[];
  onNavigate: (index: number) => void;
}) {
  return (
    <nav className="flex items-center gap-0.5 text-sm min-w-0 overflow-hidden">
      <button
        onClick={() => onNavigate(-1)}
        className="shrink-0 p-1 rounded hover:bg-accent/40 transition-colors text-muted-foreground hover:text-foreground"
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [renamingEntry, setRenamingEntry] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);
  const { previewState, openPreview, closePreview } = useFilePreview();

  // Current path from URL
  const currentPath = searchParams.get("path") || ".";
  const activeRoot = roots.find(r => currentPath === r.path || (r.path !== "." && currentPath.startsWith(r.path + "/"))) || roots[0];

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
  }, [currentPath, fetchDir]);

  const refresh = useCallback(() => fetchDir(currentPath), [currentPath, fetchDir]);

  // Navigation
  const navigateTo = useCallback((path: string) => {
    setSearch("");
    setRenamingEntry(null);
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

  const handleEntryClick = useCallback((entry: FileEntry) => {
    if (renamingEntry === entry.name) return;
    if (entry.type === "directory") {
      navigateTo(entryPath(currentPath, entry.name));
    } else {
      const mime = entry.mimeType ?? mimeFromPath(entry.name);
      openPreview({ label: entry.name, path: entryPath(currentPath, entry.name), mimeType: mime, size: entry.size });
    }
  }, [currentPath, navigateTo, openPreview, renamingEntry]);

  // ── Upload ──
  const handleUploadFiles = useCallback(async (files: globalThis.File[]) => {
    if (files.length === 0) return;
    try {
      const result = await apiUpload(currentPath, files);
      toast.success(`Uploaded ${result.count} file${result.count !== 1 ? "s" : ""}`);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    }
  }, [currentPath, refresh]);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) handleUploadFiles(Array.from(files));
    e.target.value = "";
  }, [handleUploadFiles]);

  // ── Drag & drop ──
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleUploadFiles(files);
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

    const row = (
      <div
        onClick={() => !isRenaming && handleEntryClick(entry)}
        className={cn(
          "flex items-center gap-3 w-full px-3 py-2 text-left transition-colors group cursor-pointer",
          "hover:bg-accent/30",
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

  // ── Render entry card (grid view) ──
  const renderGridEntry = (entry: FileEntry) => {
    const Icon = fileIcon(entry);
    const color = fileIconColor(entry);
    const canPreview = isPreviewableEntry(entry);

    const card = (
      <div
        onClick={() => handleEntryClick(entry)}
        className="flex flex-col items-center gap-1.5 p-3 rounded-lg transition-colors group hover:bg-accent/30 cursor-pointer"
      >
        <Icon className={cn("h-8 w-8", color)} />
        <span className="text-[11px] text-center leading-tight max-w-full truncate w-full">{entry.name}</span>
        {entry.size != null && (
          <span className="text-[9px] text-muted-foreground/50">{formatSize(entry.size)}</span>
        )}
      </div>
    );

    return (
      <ContextMenu key={entry.name}>
        <ContextMenuTrigger asChild>
          {card}
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
    <div className="flex flex-col flex-1 min-h-0 gap-0">
      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInputChange} />

      {/* Top bar */}
      <div className="flex items-center gap-2 px-1 pb-3 shrink-0">
        <div className="flex-1 min-w-0">
          <Breadcrumb segments={pathSegments} onNavigate={handleBreadcrumbNav} />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Upload */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Upload files</TooltipContent>
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

          <Separator orientation="vertical" className="h-5 mx-1" />

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Filter..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-8 w-36 lg:w-48 pl-7 text-sm"
            />
          </div>

          <Separator orientation="vertical" className="h-5 mx-1" />

          {/* Sort */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 text-xs gap-1">
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
          <div className="flex items-center border rounded-md">
            <Button variant={viewMode === "list" ? "secondary" : "ghost"} size="icon" className="h-7 w-7 rounded-r-none" onClick={() => setViewMode("list")}>
              <LayoutList className="h-3.5 w-3.5" />
            </Button>
            <Button variant={viewMode === "grid" ? "secondary" : "ghost"} size="icon" className="h-7 w-7 rounded-l-none" onClick={() => setViewMode("grid")}>
              <LayoutGrid className="h-3.5 w-3.5" />
            </Button>
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
          className="flex-1 min-w-0 flex flex-col relative"
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {/* Drag overlay */}
          {dragging && (
            <div className="absolute inset-0 z-20 bg-primary/5 border-2 border-dashed border-primary/40 rounded flex items-center justify-center pointer-events-none">
              <div className="flex flex-col items-center gap-2 text-primary">
                <Upload className="h-8 w-8" />
                <span className="text-sm font-medium">Drop files to upload</span>
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
              <ScrollArea className="flex-1">
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
                        <p className="text-xs opacity-50">Drop files here or use the upload button</p>
                      </div>
                    ) : viewMode === "list" ? (
                      <div className="divide-y divide-border/30">
                        {filtered.map(renderListEntry)}
                      </div>
                    ) : (
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-1 p-2">
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
