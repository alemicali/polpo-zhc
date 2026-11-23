import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Download, FunctionSquare, Plus, SheetIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { calculateWorkbook, isSupportedFormula } from "./artifact-sheets-formulas";
import {
  cellKey, columnLabel, displaySheetValue, readWorkbook, sheetBounds, sheetCsv,
  SHEET_COLUMNS, SHEET_ROWS, WORKBOOK_SHEETS, type CellAddress, type SheetValue, type Workbook,
} from "./artifact-sheets-model";

export { SHEETS_STARTER } from "./artifact-sheets-model";

const ROWS_PER_PAGE = 20;
const FIRST_CELL = { row: 1, col: 1 };

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
    for (const [address, raw] of Object.entries(sheet.cells)) {
      const result = get(sheet.name, address);
      worksheet.getCell(address).value = raw.startsWith("=") && !result.error && isSupportedFormula(raw)
        ? { formula: raw.slice(1), result: result.value ?? undefined }
        : result.error ?? result.value;
    }
  }
  const buffer = await output.xlsx.writeBuffer();
  saveFile(new Blob([new Uint8Array(buffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }), "workbook.xlsx");
}

export function ArtifactSheetsEditor({ content, onChange }: {
  content: string;
  onChange?: (next: string) => void;
}) {
  const workbook = useMemo(() => readWorkbook(content), [content]);
  if (!workbook) {
    return <p className="p-4 text-sm text-destructive">This workbook could not be read. Check the workbook JSON in Source.</p>;
  }
  return <WorkbookGrid workbook={workbook} onChange={onChange} />;
}

function WorkbookGrid({ workbook, onChange }: {
  workbook: Workbook;
  onChange?: (next: string) => void;
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
  const activeIndex = Math.min(sheetIndex, workbook.sheets.length - 1);
  const sheet = workbook.sheets[activeIndex];
  const getValue = useMemo(() => calculateWorkbook(workbook), [workbook]);
  const bounds = useMemo(() => sheetBounds(sheet), [sheet]);
  const rowsStart = Math.floor((selected.row - 1) / ROWS_PER_PAGE) * ROWS_PER_PAGE + 1;
  const rowsEnd = Math.min(rowsStart + ROWS_PER_PAGE - 1, SHEET_ROWS);
  const columns = Math.min(SHEET_COLUMNS, Math.max(8, bounds.col, selected.col + 1));
  const selectedKey = cellKey(selected);
  const raw = sheet.cells[selectedKey] ?? "";

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

  function updateCells(cells: Record<string, string>) {
    onChange?.(JSON.stringify({
      ...workbook,
      sheets: workbook.sheets.map((item, index) => index === activeIndex ? { ...item, cells } : item),
    }, null, 2));
  }

  function setCell(key: string, value: string) {
    if ((sheet.cells[key] ?? "") === value) return;
    const cells = { ...sheet.cells };
    if (value === "") delete cells[key];
    else cells[key] = value;
    updateCells(cells);
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
    updateCells(cells);
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
        <span className="flex items-center gap-2 text-sm font-medium">
          <SheetIcon aria-hidden="true" className="size-4 text-primary" />
          Workbook
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" disabled={exporting} onClick={() => void downloadWorkbook()}>
            <Download aria-hidden="true" /> {exporting ? "Exporting…" : "XLSX"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => {
            const filename = sheet.name.trim().replace(/[^a-z0-9 -]/gi, "").replace(/\s+/g, "-") || "sheet";
            saveFile(new Blob(["\uFEFF", sheetCsv(sheet, getValue)], { type: "text/csv;charset=utf-8" }), `${filename}.csv`);
          }}>
            <Download aria-hidden="true" /> CSV
          </Button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-12 border-r border-border pr-2 font-mono text-xs text-muted-foreground" aria-label="Active cell">{selectedKey}</span>
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

      <div className="min-h-0 flex-1 overflow-auto">
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
                    const display = displaySheetValue(result);
                    return (
                      <td
                        key={key}
                        role="gridcell"
                        aria-label={display ? `${key}: ${display}` : key}
                        aria-selected={active}
                        tabIndex={active ? 0 : -1}
                        ref={active ? selectedRef : undefined}
                        className={cn(
                          "relative h-8 max-w-36 min-w-28 cursor-cell border-b border-r border-border p-0 outline-none",
                          active && "bg-primary/5 ring-1 ring-inset ring-primary",
                        )}
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
                          <span title={display || undefined} className={cn(
                            "block max-w-36 truncate px-2 leading-8",
                            typeof result.value === "number" && "text-right tabular-nums",
                            result.error && "text-destructive",
                          )}>{display}</span>
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
