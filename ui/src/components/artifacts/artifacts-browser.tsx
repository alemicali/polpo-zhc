/**
 * The artifacts list, two ways: a sortable table (name, type, who made it, where it came from, size,
 * last change) and a file-manager layout (a compact list on the left, the selected artifact live on
 * the right). Both are driven by the keyboard (arrows move, Enter opens) and fold into a compact list
 * on a phone.
 */
import { Fragment, useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDown, ArrowUp, Download, ExternalLink, Link2, MoreHorizontal, Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { artifactLabel, type ArtifactSummary } from "@/lib/artifacts-api";
import {
  ARTIFACT_GROUP_LABEL, absoluteTime, formatArtifactSize, groupArtifactsByType, relativeTime, type ArtifactSort, type ArtifactSortKey,
} from "@/lib/artifacts-list";
import { artifactPath, type ArtifactActions } from "@/hooks/use-artifact-actions";
import { ArtifactIcon } from "./artifact-icon";

export function LegacyBadge() {
  return <Badge variant="outline" className="border-warning/40 text-micro text-warning">Legacy</Badge>;
}

type Actions = ArtifactActions;

export function ArtifactRowMenu({ artifact, actions, className }: { artifact: ArtifactSummary; actions: Actions; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className={cn("h-7 w-7", className)} aria-label={`Actions for ${artifact.title}`}
          onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => actions.open(artifact)}><ExternalLink className="h-3.5 w-3.5" /> Open</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void actions.download(artifact)}><Download className="h-3.5 w-3.5" /> Download</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void actions.copyLink(artifact)}><Link2 className="h-3.5 w-3.5" /> Copy link</DropdownMenuItem>
        {artifact.type !== "view" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void actions.remove(artifact)}><Trash2 className="h-3.5 w-3.5" /> Delete</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function When({ iso, now }: { iso: string; now?: number }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={iso} className="cursor-default">{relativeTime(iso, now)}</time>
      </TooltipTrigger>
      <TooltipContent>{absoluteTime(iso)}</TooltipContent>
    </Tooltip>
  );
}

/** Arrows / Home / End move the active row, Enter opens it (rows: the list in its shown order). */
function useListKeys<T>(rows: T[], active: number, setActive: (i: number) => void, onEnter: (row: T) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (!rows.length) return;
    const go = (i: number) => { e.preventDefault(); setActive(Math.max(0, Math.min(rows.length - 1, i))); };
    if (e.key === "ArrowDown") go(active < 0 ? 0 : active + 1);
    else if (e.key === "ArrowUp") go(active < 0 ? 0 : active - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(rows.length - 1);
    else if (e.key === "Enter" && active >= 0 && rows[active]) { e.preventDefault(); onEnter(rows[active]!); }
  };
}

function useScrollActive(container: React.RefObject<HTMLElement | null>, active: number) {
  useEffect(() => {
    if (active < 0) return;
    container.current?.querySelector<HTMLElement>(`[data-row-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [container, active]);
}

const COLUMNS: { key: ArtifactSortKey; label: string; className?: string }[] = [
  { key: "title", label: "Name" },
  { key: "type", label: "Type", className: "hidden md:table-cell" },
  { key: "createdBy", label: "Created by", className: "hidden lg:table-cell" },
  { key: "origin", label: "From", className: "hidden xl:table-cell" },
  { key: "size", label: "Size", className: "hidden lg:table-cell text-right" },
  { key: "updatedAt", label: "Updated" },
];

export interface ArtifactRowInfo {
  author: string;
  origin: { label: string; to: string } | null;
}

export function ArtifactsTable({ items, info, sort, onSort, active, setActive, actions, now }: {
  items: ArtifactSummary[];
  info: (a: ArtifactSummary) => ArtifactRowInfo;
  sort: ArtifactSort;
  onSort: (key: ArtifactSortKey) => void;
  active: number;
  setActive: (i: number) => void;
  actions: Actions;
  now?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollActive(ref, active);
  const onKeyDown = useListKeys(items, active, setActive, actions.open);
  const fromInteractive = (target: EventTarget) => !!(target as HTMLElement).closest?.("a,button,[role=menuitem]");

  return (
    <div ref={ref} tabIndex={0} onKeyDown={onKeyDown} aria-label="Artifacts"
      className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/50 bg-card/80 pb-bottom-nav outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow className="hover:bg-transparent">
            {COLUMNS.map((c) => {
              const sorted = sort.key === c.key;
              return (
                <TableHead key={c.key} className={cn("h-9 text-xs text-muted-foreground", c.key === "title" && "w-full", c.className)}
                  aria-sort={sorted ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => onSort(c.key)}
                    className={cn("inline-flex items-center gap-1 hover:text-foreground", sorted && "text-foreground", c.key === "size" && "flex-row-reverse")}>
                    {c.label}
                    {sorted && (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                  </button>
                </TableHead>
              );
            })}
            <TableHead className="h-9 w-10"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((a, i) => {
            const { author, origin } = info(a);
            return (
              <TableRow key={a.id} data-row-index={i} data-state={i === active ? "selected" : undefined} aria-selected={i === active}
                className="cursor-pointer"
                onClick={(e) => { if (!fromInteractive(e.target)) { setActive(i); actions.open(a); } }}>
                <TableCell className="w-full max-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><ArtifactIcon artifact={a} className="h-3.5 w-3.5" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Link to={artifactPath(a.id)} tabIndex={-1} className="truncate font-medium hover:underline">{a.title}</Link>
                        {a.type === "view" && <LegacyBadge />}
                        {a.pinned && <Badge variant="secondary" className="text-micro">Pinned</Badge>}
                      </div>
                      {/* on a phone the type sits under the name; on wider screens, the description */}
                      <p className="truncate text-caption text-muted-foreground md:hidden">{artifactLabel(a)}</p>
                      {a.description && <p className="hidden truncate text-caption text-muted-foreground md:block">{a.description}</p>}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{artifactLabel(a)}{a.type !== "view" ? ` · v${a.version}` : ""}</TableCell>
                <TableCell className="hidden text-xs lg:table-cell">{author}</TableCell>
                <TableCell className="hidden max-w-48 truncate text-xs xl:table-cell">
                  {origin ? <Link to={origin.to} className="text-muted-foreground hover:text-foreground hover:underline">{origin.label}</Link> : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="hidden text-right text-xs tabular-nums text-muted-foreground lg:table-cell">{formatArtifactSize(a.size)}</TableCell>
                <TableCell className="text-xs text-muted-foreground"><When iso={a.updatedAt} now={now} /></TableCell>
                <TableCell className="w-10 p-1"><ArtifactRowMenu artifact={a} actions={actions} /></TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

const isWide = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1024px)").matches;

export function ArtifactsPreviewLayout({ items, selectedId, onSelect, info, actions, now, preview }: {
  items: ArtifactSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  info: (a: ArtifactSummary) => ArtifactRowInfo;
  actions: Actions;
  now?: number;
  /** The selected artifact, live (the detail, embedded). */
  preview: ReactNode;
}) {
  const groups = useMemo(() => groupArtifactsByType(items), [items]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const indexOf = useMemo(() => new Map(flat.map((a, i) => [a.id, i])), [flat]);
  const active = flat.findIndex((a) => a.id === selectedId);
  const ref = useRef<HTMLDivElement>(null);
  useScrollActive(ref, active);
  const pick = (a: ArtifactSummary) => (isWide() ? onSelect(a.id) : actions.open(a));
  const onKeyDown = useListKeys(flat, active, (i) => onSelect(flat[i]!.id), actions.open);

  return (
    <div className="flex min-h-0 flex-1 gap-3">
      <div ref={ref} role="listbox" aria-label="Artifacts" tabIndex={0} onKeyDown={onKeyDown}
        aria-activedescendant={active >= 0 ? `artifact-option-${flat[active]!.id}` : undefined}
        className="min-h-0 w-full shrink-0 overflow-auto rounded-lg border border-border/50 bg-card/80 p-1 pb-bottom-nav outline-none focus-visible:ring-2 focus-visible:ring-ring lg:w-80 xl:w-96">
        {groups.map((g) => (
          <Fragment key={g.type}>
            <p className="px-2 pb-1 pt-2 text-micro font-medium uppercase text-muted-foreground">{ARTIFACT_GROUP_LABEL[g.type]} · {g.items.length}</p>
            {g.items.map((a) => {
              const i = indexOf.get(a.id) ?? -1;
              const selected = a.id === selectedId;
              return (
                <div key={a.id} id={`artifact-option-${a.id}`} role="option" aria-selected={selected} data-row-index={i}
                  onClick={() => pick(a)}
                  className={cn("group flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5",
                    selected ? "border-primary/40 bg-primary/5" : "border-transparent hover:bg-muted/60")}>
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><ArtifactIcon artifact={a} className="h-3 w-3" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{a.title}</span>
                      {a.pinned && <Badge variant="secondary" className="text-micro">Pinned</Badge>}
                    </span>
                    <span className="block truncate text-micro text-muted-foreground">{artifactLabel(a)} · {info(a).author} · {relativeTime(a.updatedAt, now)}</span>
                  </span>
                  <ArtifactRowMenu artifact={a} actions={actions} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100" />
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
      <section aria-label="Preview" className="hidden min-h-0 min-w-0 flex-1 flex-col lg:flex">
        {preview}
      </section>
    </div>
  );
}
