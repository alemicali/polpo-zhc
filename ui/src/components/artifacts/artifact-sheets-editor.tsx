import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Download, FunctionSquare, Plus, SheetIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SheetFormatBar } from "./artifact-sheets-format-bar";
import { calculateWorkbook, isSupportedFormula } from "./artifact-sheets-formulas";
import {
  cellKey, columnLabel, formattedSheetValue, readWorkbook, sheetBounds, sheetCsv, xlsxNumberFormat,
  SHEET_COLUMNS, SHEET_ROWS, WORKBOOK_SHEETS, type CellAddress, type CellStyle, type Sheet, type SheetValue, type Workbook,
} from "./artifact-sheets-model";

export { SHEETS_STARTER } from "./artifact-sheets-model";

const ROWS_PER_PAGE = 20;
const FIRST_CELL = { row: 1, col: 1 };
const EMPTY_STYLE: CellStyle = {};

function revealWorksheet(viewport: HTMLDivElement, sweep: HTMLDivElement, cells: Sheet["cells"], prior?: Sheet["cells"]): Animation[] {
  if (!sweep.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return [];
  const bounds = viewport.getBoundingClientRect();
  const visibleTop = bounds.top + (viewport.querySelector("thead")?.getBoundingClientRect().height ?? 0);
  const visibleLeft = bounds.left + (viewport.querySelector("thead th")?.getBoundingClientRect().width ?? 0);
  const visibleBottom = bounds.top + viewport.clientHeight;
  const visibleRight = bounds.left + viewport.clientWidth;
  const changing = Array.from(viewport.querySelectorAll<HTMLElement>("[data-sheet-value]")).flatMap((label) => {
    const key = label.dataset.sheetValue ?? "";
    if (!cells[key] || cells[key] === prior?.[key]) return [];
    const rect = label.getBoundingClientRect();
    if (rect.bottom <= visibleTop || rect.top >= visibleBottom || rect.right <= visibleLeft || rect.left >= visibleRight) return [];
    return [{ label, top: Math.max(visibleTop, rect.top), left: Math.max(visibleLeft, rect.left) }];
  });
  if (changing.length === 0) return [];

  const first = Math.min(...changing.map((cell) => cell.top));
  const last = Math.max(...changing.map((cell) => cell.top));
  const rowTravel = Math.max(32, last - first);
  const across = Math.max(1, visibleRight - visibleLeft);
  const duration = Math.min(740, 430 + rowTravel / 2);
  const shift = (y: number) => `translateY(${y - bounds.top}px)`;
  const animations = [sweep.animate([
    { transform: shift(first - 12), opacity: 0, offset: 0 },
    { opacity: 1, offset: 0.12 },
    { opacity: 0.8, offset: 0.62 },
    { transform: shift(Math.min(visibleBottom, last + 12)), opacity: 0, offset: 1 },
  ], { duration, easing: "cubic-bezier(.17,.67,.31,1)" })];

  // Keep the first paint bounded on dense sheets while the sweep covers the entire visible range.
  const step = Math.max(1, Math.ceil(changing.length / 160));
  for (let index = 0; index < changing.length; index += step) {
    const { label, top, left } = changing[index];
    const delay = (top - first) / rowTravel * (duration - 310) + (left - visibleLeft) / across * 65;
    animations.push(label.animate([
      { opacity: 0.62, transform: "translateY(3px)", backgroundColor: "transparent" },
      { opacity: 1, transform: "translateY(0)", backgroundColor: "color-mix(in oklab, var(--primary) 16%, transparent)", offset: 0.45 },
      { opacity: 1, transform: "translateY(0)", backgroundColor: "transparent" },
    ], { delay, duration: 300, fill: "backwards", easing: "cubic-bezier(.2,.75,.24,1)" }));
  }
  return animations;
}

function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function saveXlsx(workbook: Workbook, get: (sheetName: string, key: string) => SheetValue) {
  const { default: excel } = await import("exceljs");
  const output = new excel.Workbook();
  for (const sheet of workbook.sheets) {
    const worksheet = output.addWorksheet(sheet.name);
    const addresses = new Set([...Object.keys(sheet.cells), ...Object.keys(sheet.styles ?? {})]);
    for (const address of addresses) {
      const raw = sheet.cells[address];
      const result = get(sheet.name, address);
      const cell = worksheet.getCell(address);
      cell.value = raw?.startsWith("=") && !result.error && isSupportedFormula(raw)
        ? { formula: raw.slice(1), result: result.value ?? undefined }
        : result.error ?? result.value;
      const style = sheet.styles?.[address];
      if (!style) continue;
      cell.font = {
        ...cell.font,
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        ...(style.color ? { color: { argb: "FF" + style.color.slice(1).toUpperCase() } } : {}),
      };
      if (style.align) cell.alignment = { horizontal: style.align };
      if (style.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + style.fill.slice(1).toUpperCase() } };
      const numberFormat = xlsxNumberFormat(style);
      if (numberFormat) cell.numFmt = numberFormat;
    }
  }
  const buffer = await output.xlsx.writeBuffer();
  saveFile(new Blob([new Uint8Array(buffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }), "workbook.xlsx");
}

export function ArtifactSheetsEditor({ content, onChange, appearanceVersion }: {
  content: string;
  onChange?: (next: string) => void;
  appearanceVersion?: number;
}) {
  const workbook = useMemo(() => readWorkbook(content), [content]);
  if (!workbook) {
    return <p className="p-4 text-sm text-destructive">This workbook could not be read. Check the workbook JSON in Source.</p>;
  }
  return <WorkbookGrid workbook={workbook} onChange={onChange} appearanceVersion={appearanceVersion} />;
}

function WorkbookGrid({ workbook, onChange, appearanceVersion }: {
  workbook: Workbook;
  onChange?: (next: string) => void;
  appearanceVersion?: number;
}) {
  const [sheetIndex, setSheetIndex] = useState(0);
  const [selected, setSelected] = useState(FIRST_CELL);
  const [edit, setEdit] = useState<string | null>(null);
  const [formulaDraft, setFormulaDraft] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const selectedRef = useRef<HTMLTableCellElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusSelected = useRef(false);
  const formulaCancelled = useRef(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const sweepRef = useRef<HTMLDivElement>(null);
  const appearance = useRef<{ version?: number; workbook: Workbook; worksheet: string; firstRow: number }>(null);
  const revealAnimations = useRef<Animation[]>([]);
  const activeIndex = Math.min(sheetIndex, workbook.sheets.length - 1);
  const sheet = workbook.sheets[activeIndex];
  const getValue = useMemo(() => calculateWorkbook(workbook), [workbook]);
  const bounds = useMemo(() => sheetBounds(sheet), [sheet]);
  const rowsStart = Math.floor((selected.row - 1) / ROWS_PER_PAGE) * ROWS_PER_PAGE + 1;
  const rowsEnd = Math.min(rowsStart + ROWS_PER_PAGE - 1, SHEET_ROWS);
  const columns = Math.min(SHEET_COLUMNS, Math.max(8, bounds.col, selected.col + 1));
  const selectedKey = cellKey(selected);
  const raw = sheet.cells[selectedKey] ?? "";
  const selectedStyle = sheet.styles?.[selectedKey] ?? EMPTY_STYLE;

  useLayoutEffect(() => {
    const previous = appearance.current;
    appearance.current = { version: appearanceVersion, workbook, worksheet: sheet.name, firstRow: rowsStart };
    const versionChanged = !previous || previous.version !== appearanceVersion;
    if (versionChanged || previous.worksheet !== sheet.name || previous.firstRow !== rowsStart) {
      for (const animation of revealAnimations.current) animation.cancel();
      revealAnimations.current = [];
    }
    if (!versionChanged || !viewportRef.current || !sweepRef.current) return;
    const prior = previous?.workbook.sheets.find((item) => item.name === sheet.name);
    revealAnimations.current = revealWorksheet(viewportRef.current, sweepRef.current, sheet.cells, prior?.cells);
  }, [appearanceVersion, rowsStart, sheet, workbook]);

  useEffect(() => {
    if (edit !== null) inputRef.current?.focus();
    else if (focusSelected.current) {
      focusSelected.current = false;
      selectedRef.current?.focus();
    }
  }, [selected, activeIndex, edit]);

  function move(row: number, col: number) {
    focusSelected.current = true;
    setSelected({ row: Math.min(SHEET_ROWS, Math.max(1, row)), col: Math.min(SHEET_COLUMNS, Math.max(1, col)) });
  }

  function updateSheet(next: Sheet) {
    onChange?.(JSON.stringify({
      ...workbook,
      sheets: workbook.sheets.map((item, index) => index === activeIndex ? next : item),
    }, null, 2));
  }

  function setStyle(next: CellStyle) {
    const styles = { ...sheet.styles };
    if (Object.values(next).some((value) => value !== undefined)) styles[selectedKey] = next;
    else delete styles[selectedKey];
    updateSheet({ ...sheet, styles: Object.keys(styles).length ? styles : undefined });
  }

  function setCell(key: string, value: string) {
    if ((sheet.cells[key] ?? "") === value) return;
    const cells = { ...sheet.cells };
    if (value === "") delete cells[key];
    else cells[key] = value;
    updateSheet({ ...sheet, cells });
  }

  function commitEdit() {
    if (edit === null) return;
    setCell(selectedKey, edit);
    setEdit(null);
  }

  function commitFormula() {
    if (!formulaCancelled.current && formulaDraft !== null) setCell(selectedKey, formulaDraft);
    formulaCancelled.current = false;
    setFormulaDraft(null);
  }

  function handleGridKey(event: KeyboardEvent<HTMLTableCellElement>) {
    if (event.target !== event.currentTarget) return;
    const { row, col } = selected;
    const nextByKey: Record<string, CellAddress> = {
      ArrowUp: { row: row - 1, col },
      ArrowDown: { row: row + 1, col },
      ArrowLeft: { row, col: col - 1 },
      ArrowRight: { row, col: col + 1 },
      Home: { row: event.ctrlKey || event.metaKey ? 1 : row, col: 1 },
      End: { row: event.ctrlKey || event.metaKey ? bounds.row : row, col: bounds.col },
      PageUp: { row: row - ROWS_PER_PAGE, col },
      PageDown: { row: row + ROWS_PER_PAGE, col },
    };
    const next = nextByKey[event.key];
    if (next) {
      event.preventDefault();
      move(next.row, next.col);
      return;
    }
    if (onChange && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      const shortcut = event.key.toLowerCase();
      const key = shortcut === "b" ? "bold" : shortcut === "i" ? "italic" : shortcut === "u" ? "underline" : undefined;
      if (key) {
        event.preventDefault();
        setStyle({ ...selectedStyle, [key]: selectedStyle[key] ? undefined : true });
        return;
      }
    }
    if (!onChange || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      setCell(selectedKey, "");
    } else if (event.key === "Enter" || event.key === "F2" || event.key.length === 1) {
      event.preventDefault();
      setEdit(event.key.length === 1 ? event.key : raw);
    }
  }

  function handleEditKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setEdit(null);
      move(selected.row, selected.col);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      commitEdit();
      const delta = event.shiftKey ? -1 : 1;
      if (event.key === "Enter") move(selected.row + delta, selected.col);
      else move(selected.row, selected.col + delta);
    }
  }

  function pasteCells(event: ClipboardEvent<HTMLTableCellElement>) {
    if (!onChange || event.target !== event.currentTarget) return;
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain").replace(/\r\n/g, "\n").replace(/\n$/, "");
    const cells = { ...sheet.cells };
    const lines = text.split("\n").slice(0, SHEET_ROWS - selected.row + 1);
    lines.forEach((line, rowOffset) => {
      line.split("\t").slice(0, SHEET_COLUMNS - selected.col + 1).forEach((value, colOffset) => {
        const key = cellKey({ row: selected.row + rowOffset, col: selected.col + colOffset });
        if (value === "") delete cells[key];
        else cells[key] = value;
      });
    });
    updateSheet({ ...sheet, cells });
  }

  function addSheet() {
    const names = new Set(workbook.sheets.map((item) => item.name.toLowerCase()));
    let number = workbook.sheets.length + 1;
    while (names.has(`sheet ${number}`)) number += 1;
    onChange?.(JSON.stringify({
      ...workbook,
      sheets: [...workbook.sheets, { name: `Sheet ${number}`, cells: {} }],
    }, null, 2));
    setSheetIndex(workbook.sheets.length);
    setSelected(FIRST_CELL);
  }

  async function downloadWorkbook() {
    setExporting(true);
    try {
      await saveXlsx(workbook, getValue);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not export workbook");
    } finally {
      setExporting(false);
    }
  }

  return (
    <section aria-label="Spreadsheet" className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
        <span className="flex items-center gap-2.5 text-sm font-semibold">
          <span className="grid size-7 place-items-center rounded-control bg-primary/10 text-primary">
            <SheetIcon aria-hidden="true" className="size-4" />
          </span>
          Workbook
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button type="button" variant="outline" size="xs" title="Download workbook" disabled={exporting} onClick={() => void downloadWorkbook()}>
            <Download aria-hidden="true" /> {exporting ? "Exporting…" : "XLSX"}
          </Button>
          <Button type="button" variant="ghost" size="xs" title="Download active worksheet" onClick={() => {
            const filename = sheet.name.trim().replace(/[^a-z0-9 -]/gi, "").replace(/\s+/g, "-") || "sheet";
            saveFile(new Blob(["\uFEFF", sheetCsv(sheet, getValue)], { type: "text/csv;charset=utf-8" }), `${filename}.csv`);
          }}>
            <Download aria-hidden="true" /> CSV
          </Button>
        </div>
      </div>

      {onChange && <SheetFormatBar style={selectedStyle} onChange={(patch) => setStyle({ ...selectedStyle, ...patch })}
        onClear={() => setStyle(EMPTY_STYLE)} />}

      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5">
        <span className="min-w-12 border-r border-border pr-2 font-mono text-xs font-semibold text-primary" aria-label="Active cell">{selectedKey}</span>
        <FunctionSquare aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <Input
          aria-label="Cell value or formula"
          className="h-7 min-w-0 border-transparent bg-transparent px-2 font-mono text-xs shadow-none"
          readOnly={!onChange}
          value={formulaDraft ?? raw}
          onChange={(event) => setFormulaDraft(event.target.value)}
          onBlur={commitFormula}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" || event.key === "Enter") {
              event.preventDefault();
              formulaCancelled.current = event.key === "Escape";
              event.currentTarget.blur();
              move(selected.row, selected.col);
            }
          }}
        />
      </div>

      <div className="relative isolate min-h-0 flex-1 overflow-hidden">
        <div ref={viewportRef} className="absolute inset-0 overflow-auto">
          <table role="grid" aria-label={sheet.name} aria-rowcount={SHEET_ROWS + 1} aria-colcount={SHEET_COLUMNS + 1}
            aria-readonly={!onChange} className="w-max min-w-full border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-20 bg-muted">
              <tr aria-rowindex={1}>
                <th className="sticky left-0 w-12 min-w-12 border-b border-r border-border bg-muted" scope="col" aria-label="Rows" />
                {Array.from({ length: columns }, (_, index) => (
                  <th key={index} scope="col" className={cn(
                    "h-7 min-w-28 border-b border-r border-border px-2 text-center font-mono font-medium text-muted-foreground",
                    selected.col === index + 1 && "bg-primary/10 text-primary",
                  )}>{columnLabel(index + 1)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rowsEnd - rowsStart + 1 }, (_, rowOffset) => {
                const row = rowsStart + rowOffset;
                return (
                  <tr key={row} aria-rowindex={row + 1}>
                    <th scope="row" className={cn(
                      "sticky left-0 z-10 h-8 border-b border-r border-border bg-muted px-2 text-right font-mono font-normal text-muted-foreground",
                      selected.row === row && "bg-accent text-primary",
                    )}>{row}</th>
                    {Array.from({ length: columns }, (_, index) => {
                      const col = index + 1;
                      const key = cellKey({ row, col });
                      const active = selected.row === row && selected.col === col;
                      const result = getValue(sheet.name, key);
                      const cellStyle = sheet.styles?.[key];
                      const display = formattedSheetValue(result, cellStyle);
                      return (
                        <td
                          key={key}
                          role="gridcell"
                          aria-label={display ? `${key}: ${display}` : key}
                          aria-selected={active}
                          tabIndex={active ? 0 : -1}
                          ref={active ? selectedRef : undefined}
                          className={cn(
                            "relative h-8 max-w-36 min-w-28 cursor-cell border-b border-r border-border/75 p-0 outline-none hover:bg-muted/35",
                            active && "bg-primary/5 ring-1 ring-inset ring-primary",
                          )}
                          style={cellStyle?.fill ? { backgroundColor: cellStyle.fill } : undefined}
                          onClick={() => { if (!active) move(row, col); }}
                          onDoubleClick={() => { if (onChange && active) setEdit(raw); }}
                          onKeyDown={handleGridKey}
                          onPaste={pasteCells}
                          onCopy={(event) => {
                            if (event.target !== event.currentTarget) return;
                            event.preventDefault();
                            event.clipboardData.setData("text/plain", display);
                          }}
                        >
                          {active && edit !== null ? (
                            <input
                              ref={inputRef}
                              aria-label={`Edit ${key}`}
                              className="absolute inset-0 h-full w-full bg-background px-2 outline-none focus:ring-2 focus:ring-inset focus:ring-primary"
                              value={edit}
                              onChange={(event) => setEdit(event.target.value)}
                              onBlur={commitEdit}
                              onKeyDown={handleEditKey}
                            />
                          ) : (
                            <span data-sheet-value={display ? key : undefined} title={display || undefined} className={cn(
                              "block max-w-36 truncate px-2 leading-8",
                              typeof result.value === "number" && "text-right tabular-nums",
                              result.error && "text-destructive",
                              cellStyle?.bold && "font-bold",
                              cellStyle?.italic && "italic",
                              cellStyle?.underline && "underline",
                            )} style={{ textAlign: cellStyle?.align, color: result.error ? undefined : cellStyle?.color }}>{display}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div ref={sweepRef} aria-hidden="true" className="pointer-events-none absolute left-12 right-0 top-0 z-10 h-8 border-t border-primary/35 opacity-0"
          style={{ background: "linear-gradient(to bottom, color-mix(in oklab, var(--primary) 15%, transparent), transparent)" }} />
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border bg-card px-2 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-auto" role="group" aria-label="Worksheets">
          {workbook.sheets.map((item, index) => (
            <Button key={item.name} type="button" size="xs" variant={index === activeIndex ? "secondary" : "ghost"}
              aria-pressed={index === activeIndex} onClick={() => {
                setSheetIndex(index);
                setSelected(FIRST_CELL);
              }}>{item.name}</Button>
          ))}
          {onChange && (
            <Button type="button" size="icon-xs" variant="ghost" aria-label="Add worksheet"
              disabled={workbook.sheets.length >= WORKBOOK_SHEETS} onClick={addSheet}>
              <Plus aria-hidden="true" />
            </Button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-caption text-muted-foreground">
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Previous rows"
            disabled={rowsStart === 1} onClick={() => move(rowsStart - ROWS_PER_PAGE, selected.col)}><ChevronLeft aria-hidden="true" /></Button>
          <span className="tabular-nums">Rows {rowsStart}–{rowsEnd}</span>
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Next rows"
            disabled={rowsEnd === SHEET_ROWS} onClick={() => move(rowsEnd + 1, selected.col)}><ChevronRight aria-hidden="true" /></Button>
        </div>
      </div>
    </section>
  );
}
