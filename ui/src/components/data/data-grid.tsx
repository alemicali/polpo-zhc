/**
 * The data grid — Lumea's TableDataView (database panel) on Polpo's tokens and APIs: row selection
 * with checkboxes, sortable headers, hidden columns, NULL styling, a loading skeleton, an error and
 * an empty state, and the footer with rows per page and paging. Added for Polpo: keyboard navigation
 * (arrows, Home/End, PageUp/PageDown move between cells; Enter opens the row; F2 or a double click
 * edits the cell in place; Space selects the row; Escape cancels), an open-row button, and a
 * read-only mode for SQL results.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertCircle, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, KeyRound, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { DataColumn } from "@/hooks/use-data";
import { cn } from "@/lib/utils";
import { formatCell, truncate } from "./data-utils";

export interface DataGridSort { field: string; direction: "asc" | "desc" }

export interface DataGridPaging {
  offset: number;
  limit: number;
  /** Every matching row, when the source can count. */
  total?: number;
  /** More rows exist after this page (when there is no total). */
  hasMore: boolean;
  onPage: (offset: number) => void;
  onLimit: (limit: number) => void;
}

export interface DataGridProps {
  columns: DataColumn[];
  rows: Record<string, unknown>[];
  /** A stable key per row (primary key when there is one). */
  getRowKey?: (row: Record<string, unknown>, index: number) => string;
  loading?: boolean;
  error?: string;
  emptyLabel?: string;
  hiddenColumns?: Set<string>;
  sort?: DataGridSort | null;
  onSort?: (field: string) => void;
  /** Row selection (omit for a read-only grid). */
  selected?: Set<string>;
  onSelectedChange?: (next: Set<string>) => void;
  onOpenRow?: (row: Record<string, unknown>, index: number) => void;
  /** In-place edit of one cell (the parent confirms and saves). */
  onEditCell?: (row: Record<string, unknown>, column: DataColumn, raw: string) => void;
  paging?: DataGridPaging;
  ariaLabel: string;
  className?: string;
}

const PAGE_SIZES = [25, 50, 100, 250];

export function DataGrid({
  columns, rows, getRowKey = (_row, index) => String(index), loading, error, emptyLabel = "No results.",
  hiddenColumns, sort, onSort, selected, onSelectedChange, onOpenRow, onEditCell, paging, ariaLabel, className,
}: DataGridProps) {
  const visible = useMemo(() => columns.filter((column) => !hiddenColumns?.has(column.name)), [columns, hiddenColumns]);
  const selectable = !!selected && !!onSelectedChange;
  const keys = useMemo(() => rows.map((row, index) => getRowKey(row, index)), [rows, getRowKey]);
  const allSelected = selectable && rows.length > 0 && keys.every((key) => selected.has(key));
  const someSelected = selectable && keys.some((key) => selected.has(key));
  const offsetCols = (selectable ? 1 : 0);
  const lastCol = offsetCols + visible.length - 1 + (onOpenRow ? 1 : 0);

  // Roving focus: one cell is tabbable; arrows move it.
  const [active, setActive] = useState<{ row: number; col: number }>({ row: 0, col: offsetCols });
  const [editing, setEditing] = useState<{ row: number; col: number; value: string } | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const focusPending = useRef(false);
  const clampedRow = Math.min(active.row, Math.max(0, rows.length - 1));
  const clampedCol = Math.min(active.col, lastCol);

  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    tableRef.current?.querySelector<HTMLElement>(`[data-cell="${clampedRow}:${clampedCol}"]`)?.focus();
  });

  const move = useCallback((row: number, col: number) => {
    focusPending.current = true;
    setActive({ row: Math.max(0, Math.min(rows.length - 1, row)), col: Math.max(0, Math.min(lastCol, col)) });
  }, [lastCol, rows.length]);

  const toggleRow = (key: string) => {
    if (!selectable) return;
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    onSelectedChange(next);
  };
  const toggleAll = () => {
    if (!selectable) return;
    onSelectedChange(allSelected ? new Set([...selected].filter((key) => !keys.includes(key))) : new Set([...selected, ...keys]));
  };

  const columnAt = (col: number): DataColumn | undefined => visible[col - offsetCols];
  const startEdit = (row: number, col: number) => {
    const column = columnAt(col);
    if (!onEditCell || !column || column.primaryKey) return;
    const value = rows[row]?.[column.name];
    setEditing({ row, col, value: value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value) });
  };
  const commitEdit = () => {
    if (!editing) return;
    const column = columnAt(editing.col);
    const row = rows[editing.row];
    setEditing(null);
    focusPending.current = true;
    if (column && row && onEditCell) onEditCell(row, column, editing.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, row: number, col: number) => {
    if (editing) return;
    const page = 10;
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); move(row + 1, col); break;
      case "ArrowUp": event.preventDefault(); move(row - 1, col); break;
      case "ArrowRight": event.preventDefault(); move(row, col + 1); break;
      case "ArrowLeft": event.preventDefault(); move(row, col - 1); break;
      case "Home": event.preventDefault(); move(event.ctrlKey ? 0 : row, 0); break;
      case "End": event.preventDefault(); move(event.ctrlKey ? rows.length - 1 : row, lastCol); break;
      case "PageDown": event.preventDefault(); move(row + page, col); break;
      case "PageUp": event.preventDefault(); move(row - page, col); break;
      case "Enter": if (onOpenRow && rows[row]) { event.preventDefault(); onOpenRow(rows[row], row); } break;
      case "F2": event.preventDefault(); startEdit(row, col); break;
      case " ": if (selectable && keys[row]) { event.preventDefault(); toggleRow(keys[row]); } break;
    }
  };

  const ariaSort = (field: string): "ascending" | "descending" | "none" =>
    sort?.field === field ? (sort.direction === "asc" ? "ascending" : "descending") : "none";
  const cellProps = (row: number, col: number) => ({
    "data-cell": `${row}:${col}`,
    tabIndex: row === clampedRow && col === clampedCol ? 0 : -1,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => onKeyDown(event, row, col),
    onFocus: () => { if (active.row !== row || active.col !== col) setActive({ row, col }); },
  });

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="min-h-0 flex-1 overflow-auto rounded-card border border-border">
        {loading && rows.length === 0 ? <DataGridSkeleton columns={Math.min(Math.max(visible.length, 3), 6)} /> : error ? (
          <div role="alert" className="flex h-48 flex-col items-center justify-center gap-2 px-4 text-center">
            <AlertCircle className="size-5 text-destructive" />
            <p className="max-w-lg text-xs text-destructive">{error}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm italic text-muted-foreground">{emptyLabel}</div>
        ) : (
          <table ref={tableRef} role="grid" aria-label={ariaLabel} aria-rowcount={paging?.total ?? rows.length} aria-busy={loading || undefined} className={cn("w-full border-separate border-spacing-0 text-sm", loading && "opacity-60")}>
            <thead className="sticky top-0 z-10 bg-muted">
              <tr role="row">
                {selectable && (
                  <th role="columnheader" className="w-10 border-b border-r border-border px-3">
                    <Checkbox aria-label={allSelected ? "Deselect all rows" : "Select all rows"} checked={allSelected ? true : someSelected ? "indeterminate" : false} onCheckedChange={toggleAll} />
                  </th>
                )}
                {visible.map((column) => (
                  <th key={column.name} role="columnheader" aria-sort={onSort ? ariaSort(column.name) : undefined} className="h-9 border-b border-r border-border p-0 text-left text-xs font-medium text-muted-foreground last:border-r-0">
                    {onSort ? (
                      <button type="button" onClick={() => onSort(column.name)} className="flex h-9 w-full items-center justify-between gap-2 px-3 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <HeaderLabel column={column} />
                        {sort?.field === column.name ? (sort.direction === "asc" ? <ArrowUp className="size-3.5 shrink-0 text-foreground" /> : <ArrowDown className="size-3.5 shrink-0 text-foreground" />) : <ChevronsUpDown className="size-3.5 shrink-0 opacity-40" />}
                      </button>
                    ) : <div className="flex h-9 items-center px-3"><HeaderLabel column={column} /></div>}
                  </th>
                ))}
                {onOpenRow && <th role="columnheader" className="w-10 border-b border-border"><span className="sr-only">Open</span></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => {
                const key = keys[rowIndex]!;
                const isSelected = selectable && selected.has(key);
                return (
                  <tr key={key} role="row" aria-selected={selectable ? isSelected : undefined} className={cn("group", isSelected ? "bg-primary/5" : "hover:bg-muted/40")}>
                    {selectable && (
                      <td role="gridcell" {...cellProps(rowIndex, 0)} className="border-b border-r border-border px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                        <Checkbox tabIndex={-1} aria-label={`Select row ${rowIndex + 1}`} checked={isSelected} onCheckedChange={() => toggleRow(key)} />
                      </td>
                    )}
                    {visible.map((column, colIndex) => {
                      const col = colIndex + offsetCols;
                      const value = row[column.name];
                      const text = formatCell(value);
                      const isEditing = editing?.row === rowIndex && editing.col === col;
                      return (
                        <td
                          key={column.name}
                          role="gridcell"
                          {...cellProps(rowIndex, col)}
                          title={text}
                          onDoubleClick={() => startEdit(rowIndex, col)}
                          className={cn(
                            "max-w-80 border-b border-r border-border px-3 py-2 align-top last:border-r-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                            column.type === "number" ? "text-right tabular-nums" : "",
                            (column.type === "json" || column.primaryKey) && "font-mono text-xs",
                            value === null || value === undefined ? "italic text-muted-foreground/70" : "",
                          )}
                        >
                          {isEditing ? (
                            <input
                              autoFocus
                              aria-label={`Edit ${column.name}`}
                              value={editing.value}
                              onChange={(event) => setEditing({ ...editing, value: event.target.value })}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") { event.preventDefault(); commitEdit(); }
                                if (event.key === "Escape") { event.preventDefault(); setEditing(null); focusPending.current = true; }
                                event.stopPropagation();
                              }}
                              onBlur={() => setEditing(null)}
                              className="w-full min-w-24 rounded-xs border border-ring bg-background px-1.5 py-0.5 text-sm not-italic text-foreground outline-none"
                            />
                          ) : <span className="block truncate">{truncate(text, 120)}</span>}
                        </td>
                      );
                    })}
                    {onOpenRow && (
                      <td role="gridcell" {...cellProps(rowIndex, lastCol)} className="border-b border-border px-1 py-1 text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                        <Button tabIndex={-1} variant="ghost" size="icon-xs" aria-label={`Open row ${rowIndex + 1}`} className="opacity-60 group-hover:opacity-100" onClick={() => onOpenRow(row, rowIndex)}>
                          <Maximize2 />
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {paging && <DataGridFooter paging={paging} rowCount={rows.length} selectedCount={selectable ? selected.size : 0} />}
    </div>
  );
}

function HeaderLabel({ column }: { column: DataColumn }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {column.primaryKey && <KeyRound className="size-3 shrink-0 text-warning" aria-label="Primary key" />}
      <span className={cn("truncate", column.primaryKey && "font-semibold text-foreground")}>{column.name}</span>
      <span className="truncate font-mono text-micro font-normal text-muted-foreground/70">{column.nativeType ?? column.type}</span>
    </span>
  );
}

function DataGridFooter({ paging, rowCount, selectedCount }: { paging: DataGridPaging; rowCount: number; selectedCount: number }) {
  const page = Math.floor(paging.offset / paging.limit) + 1;
  const pages = paging.total !== undefined ? Math.max(1, Math.ceil(paging.total / paging.limit)) : undefined;
  const canNext = paging.total !== undefined ? paging.offset + paging.limit < paging.total : paging.hasMore;
  const from = rowCount ? paging.offset + 1 : 0;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-3 text-xs text-muted-foreground">
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2">
          <span className="hidden sm:inline">Rows per page</span>
          <Select value={String(paging.limit)} onValueChange={(value) => paging.onLimit(Number(value))}>
            <SelectTrigger size="sm" className="h-7 w-20 text-xs" aria-label="Rows per page"><SelectValue /></SelectTrigger>
            <SelectContent>{PAGE_SIZES.map((size) => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}</SelectContent>
          </Select>
        </label>
        <span aria-live="polite">
          {rowCount ? `${from.toLocaleString()}–${(paging.offset + rowCount).toLocaleString()}` : "0"} of {paging.total !== undefined ? paging.total.toLocaleString() : `${(paging.offset + rowCount).toLocaleString()}${paging.hasMore ? "+" : ""}`} records
          {selectedCount > 0 && ` · ${selectedCount} selected`}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span>Page {page}{pages ? ` of ${pages}` : ""}</span>
        <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={paging.offset === 0} onClick={() => paging.onPage(Math.max(0, paging.offset - paging.limit))}><ChevronLeft /></Button>
        <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={!canNext} onClick={() => paging.onPage(paging.offset + paging.limit)}><ChevronRight /></Button>
      </div>
    </div>
  );
}

const SKELETON_WIDTHS = ["w-3/5", "w-4/5", "w-2/5", "w-3/4", "w-1/2", "w-2/3"];

/** Lumea's TableSkeleton: a header and rows of pulsing bars (fixed widths, no randomness at render). */
export function DataGridSkeleton({ columns = 5, rows = 8 }: { columns?: number; rows?: number }) {
  return (
    <div className="overflow-hidden" aria-busy="true" aria-label="Loading rows">
      <div className="flex h-9 border-b border-border bg-muted">
        {Array.from({ length: columns }).map((_, index) => (
          <div key={index} className="flex flex-1 items-center border-r border-border px-3 last:border-r-0"><div className="h-2.5 w-16 animate-pulse rounded-xs bg-muted-foreground/20" /></div>
        ))}
      </div>
      {Array.from({ length: rows }).map((_, row) => (
        <div key={row} className="flex border-b border-border/60">
          {Array.from({ length: columns }).map((_, col) => (
            <div key={col} className="flex flex-1 items-center border-r border-border/60 px-3 py-3 last:border-r-0">
              <div className={cn("h-2.5 animate-pulse rounded-xs bg-muted-foreground/10", SKELETON_WIDTHS[(row + col) % SKELETON_WIDTHS.length])} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
