import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type PointerEvent } from "react";
import { ChartNoAxesColumn, ChevronDown, Download, FileUp, FunctionSquare, History, List, MoreHorizontal, MoveLeft, MoveRight, Plus, Trash2, X } from "lucide-react";
import { MAX_ARTIFACT_BYTES } from "@polpo-ai/core/artifacts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useProjectInfo } from "@/hooks/use-polpo";
import { productName, useInstanceBranding } from "@/lib/branding";
import { cn } from "@/lib/utils";
import { SheetFontMenu, SheetFormatBar, SheetFormattingMenu } from "./artifact-sheets-format-bar";
import { SheetDataTools, SheetFunctionMenu, type SheetCalculation, type SheetCellType } from "./artifact-sheets-data-tools";
import { calculateWorkbook } from "./artifact-sheets-formulas";
import { revealWorksheet, settleWorksheet, stopSheetAnimations, type SheetAnimations } from "./artifact-sheets-reveal";
import {
  acceptsCellValue, cellAddress, cellKey, cellRange, columnLabel, formattedSheetValue, matchesSheetRule, rangeContains, rangeKeys, rangeLabel, readRange,
  parseSheetRows, readWorkbook, sheetBounds, sheetCsv, SHEET_COLUMNS, SHEET_ROWS, WORKBOOK_SHEETS,
  type CellAddress, type CellStyle, type CellValidation, type Sheet, type SheetChart, type SheetRule, type Workbook,
} from "./artifact-sheets-model";

export { SHEETS_STARTER } from "./artifact-sheets-model";

const ROW_HEIGHT = 26;
const ROW_OVERSCAN = 8;
const FIRST_CELL = { row: 1, col: 1 };
const EMPTY_STYLE: CellStyle = {};
const EMPTY_RULES: SheetRule[] = [];
const EMPTY_CHARTS: SheetChart[] = [];
const ZOOM_LEVELS = [50, 75, 90, 100, 110, 125, 150, 200];
const SheetChartPreview = lazy(() => import("./artifact-sheets-chart").then((module) => ({ default: module.ArtifactSheetChart })));

function rowAt(offsets: number[], offset: number): number {
  let first = 1;
  let last = SHEET_ROWS;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (offsets[middle] <= offset) first = middle + 1;
    else last = middle;
  }
  return first;
}

function worksheetOffsets(styles?: Sheet["styles"]): number[] {
  const heights = new Array<number>(SHEET_ROWS).fill(ROW_HEIGHT);
  for (const [key, style] of Object.entries(styles ?? {})) {
    if (!style.fontSize || style.fontSize <= 16) continue;
    const address = cellAddress(key);
    if (address) heights[address.row - 1] = Math.max(heights[address.row - 1], Math.ceil(style.fontSize * 1.25) + 2);
  }
  const offsets = [0];
  for (const height of heights) offsets.push(offsets[offsets.length - 1] + height);
  return offsets;
}

function worksheetWindow(viewport: HTMLDivElement, offsets: number[], scale: number) {
  const firstVisible = rowAt(offsets, viewport.scrollTop / scale);
  return {
    start: Math.max(1, firstVisible - ROW_OVERSCAN),
    end: Math.min(SHEET_ROWS, rowAt(offsets, (viewport.scrollTop + viewport.clientHeight) / scale) + ROW_OVERSCAN),
  };
}

function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ArtifactSheetsEditor({ content, onChange, appearanceVersion, streaming = false, onShowHistory }: {
  content: string;
  onChange?: (next: string) => void;
  appearanceVersion?: number;
  streaming?: boolean;
  onShowHistory?: () => void;
}) {
  const workbook = useMemo(() => readWorkbook(content), [content]);
  if (!workbook) {
    return <p className="p-4 text-sm text-destructive">This workbook could not be read. Check the workbook JSON in Source.</p>;
  }
  return <WorkbookGrid workbook={workbook} onChange={onChange} appearanceVersion={appearanceVersion} streaming={streaming} onShowHistory={onShowHistory} />;
}

function WorkbookGrid({ workbook, onChange, appearanceVersion, streaming, onShowHistory }: {
  workbook: Workbook;
  onChange?: (next: string) => void;
  appearanceVersion?: number;
  streaming: boolean;
  onShowHistory?: () => void;
}) {
  const { info } = useProjectInfo();
  const brand = productName(useInstanceBranding());
  const product = info?.project || brand;
  const [sheetIndex, setSheetIndex] = useState(0);
  const [selected, setSelected] = useState(FIRST_CELL);
  const [selectionOrigin, setSelectionOrigin] = useState<CellAddress | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [formulaDraft, setFormulaDraft] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [zoom, setZoom] = useState(100);
  const zoomScale = zoom / 100;
  const [chartIndex, setChartIndex] = useState<number | null>(workbook.sheets[0].charts?.length ? 0 : null);
  const [rowWindow, setRowWindow] = useState({ start: 1, end: 32 });
  const selectedRef = useRef<HTMLTableCellElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const liveWorkbook = useRef({ workbook, onChange });
  const importEpoch = useRef(0);
  const focusSelected = useRef(false);
  const selectionGesture = useRef(false);
  const formulaCancelled = useRef(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<{ top: number; left: number }>(null);
  const sweepRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLDivElement>(null);
  const appearance = useRef<{ version?: number; workbook: Workbook; worksheet: string; streaming: boolean }>(null);
  const revealAnimations = useRef<SheetAnimations>({ cells: new Map(), outlines: new Map(), lastSweep: -Infinity });
  const activeIndex = Math.min(sheetIndex, workbook.sheets.length - 1);
  const sheet = workbook.sheets[activeIndex];
  const getValue = useMemo(() => calculateWorkbook(workbook), [workbook]);
  const bounds = useMemo(() => sheetBounds(sheet), [sheet]);
  const rowOffsets = useMemo(() => worksheetOffsets(sheet.styles), [sheet.styles]);
  const { start: rowsStart, end: rowsEnd } = rowWindow;
  const columns = Math.min(SHEET_COLUMNS, Math.max(12, bounds.col + 1, selected.col + 1));
  const selectedKey = cellKey(selected);
  const selection = cellRange(selectionOrigin ?? selected, selected);
  const selectionLabel = rangeLabel(selection);
  const raw = sheet.cells[selectedKey] ?? "";
  const selectedStyle = sheet.styles?.[selectedKey] ?? EMPTY_STYLE;
  const selectedValidation = sheet.validations?.[selectedKey];
  const cellType = selectedValidation?.type === "checkbox" ? "checkbox" : selectedStyle.numberFormat === "date" ? "date" : "automatic";
  const rules = sheet.rules ?? EMPTY_RULES;
  const charts = sheet.charts ?? EMPTY_CHARTS;
  const chart = chartIndex === null ? undefined : charts[chartIndex];
  const ruleRanges = useMemo(() => rules.flatMap((rule) => {
    const range = readRange(rule.range);
    return range ? [{ rule, range }] : [];
  }), [rules]);

  useLayoutEffect(() => {
    liveWorkbook.current = { workbook, onChange };
  }, [workbook, onChange]);

  useEffect(() => () => { importEpoch.current += 1; }, []);

  const measureRows = useCallback((viewport: HTMLDivElement) => {
    const next = worksheetWindow(viewport, rowOffsets, zoomScale);
    setRowWindow((before) => before.start === next.start && before.end === next.end ? before : next);
  }, [rowOffsets, zoomScale]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (pendingScroll.current) {
      viewport.scrollTo(pendingScroll.current);
      pendingScroll.current = null;
    }
    measureRows(viewport);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measureRows(viewport)) : undefined;
    observer?.observe(viewport);
    return () => observer?.disconnect();
  }, [measureRows]);

  useLayoutEffect(() => {
    const animations = revealAnimations.current;
    return () => {
      stopSheetAnimations(animations);
      appearance.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const previous = appearance.current;
    appearance.current = { version: appearanceVersion, workbook, worksheet: sheet.name, streaming };
    const versionChanged = !previous || previous.version !== appearanceVersion;
    if (previous && previous.worksheet !== sheet.name) stopSheetAnimations(revealAnimations.current);
    if (previous?.streaming && !streaming) settleWorksheet(revealAnimations.current, badgeRef.current);
    if (!versionChanged || !viewportRef.current || !sweepRef.current) return;
    const prior = previous?.workbook.sheets.find((item) => item.name === sheet.name);
    revealWorksheet(viewportRef.current, sweepRef.current, badgeRef.current, sheet.cells, prior?.cells, revealAnimations.current, streaming);
  }, [appearanceVersion, sheet, streaming, workbook]);

  function updateViewport(viewport: HTMLDivElement) {
    measureRows(viewport);
    const animations = revealAnimations.current;
    animations.badge?.cancel();
    animations.badge = undefined;
    const { outlines } = animations;
    for (const [element, animation] of outlines) {
      if (element.isConnected) continue;
      animation.cancel();
      outlines.delete(element);
    }
  }

  useEffect(() => {
    if (edit !== null) inputRef.current?.focus();
    else if (focusSelected.current) {
      const viewport = viewportRef.current;
      if (!selectedRef.current && viewport) {
        viewport.scrollTop = rowOffsets[selected.row - 1] * zoomScale;
        measureRows(viewport);
        return;
      }
      focusSelected.current = false;
      selectedRef.current?.focus();
    }
  }, [selected, activeIndex, edit, rowWindow, rowOffsets, measureRows, zoomScale]);

  function resetViewport() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: 0, left: 0 });
    measureRows(viewport);
  }

  function changeZoom(next: number) {
    const viewport = viewportRef.current;
    if (next === zoom) return;
    if (viewport) pendingScroll.current = { top: viewport.scrollTop * next / zoom, left: viewport.scrollLeft * next / zoom };
    setZoom(next);
  }

  function selectWorksheet(index: number) {
    if (index === activeIndex) return;
    setSheetIndex(index);
    setSelected(FIRST_CELL);
    setSelectionOrigin(null);
    setChartIndex(null);
    resetViewport();
  }

  function move(row: number, col: number, extend = false) {
    focusSelected.current = true;
    setSelectionOrigin((origin) => extend ? origin ?? selected : null);
    setSelected({ row: Math.min(SHEET_ROWS, Math.max(1, row)), col: Math.min(SHEET_COLUMNS, Math.max(1, col)) });
  }

  function selectRow(row: number) {
    move(row, 1);
    setSelectionOrigin({ row, col: SHEET_COLUMNS });
  }

  function selectColumn(col: number) {
    move(1, col);
    setSelectionOrigin({ row: SHEET_ROWS, col });
  }

  function beginSelection(event: PointerEvent<HTMLTableCellElement>, row: number, col: number) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("input,select,button")) return;
    // Prevent browser text selection while dragging across worksheet cells.
    if (event.pointerType === "mouse") event.preventDefault();
    selectionGesture.current = event.pointerType === "mouse";
    move(row, col, event.shiftKey);
  }

  function updateSheet(next: Sheet) {
    onChange?.(JSON.stringify({
      ...workbook,
      sheets: workbook.sheets.map((item, index) => index === activeIndex ? next : item),
    }, null, 2));
  }

  function setStyle(patch: Partial<CellStyle> | null) {
    const styles = { ...sheet.styles };
    for (const key of rangeKeys(selection)) {
      const next = patch ? { ...styles[key], ...patch } : null;
      if (next && Object.values(next).some((value) => value !== undefined)) styles[key] = next;
      else delete styles[key];
    }
    updateSheet({ ...sheet, styles: Object.keys(styles).length ? styles : undefined });
  }

  function setCell(key: string, value: string) {
    if ((sheet.cells[key] ?? "") === value) return;
    if (!acceptsCellValue(value, sheet.validations?.[key])) {
      toast.error(`${key} requires a value allowed by its validation.`);
      return;
    }
    const cells = { ...sheet.cells };
    if (value === "") delete cells[key];
    else cells[key] = value;
    updateSheet({ ...sheet, cells });
  }

  function setValidation(validation: CellValidation | null) {
    const validations = { ...sheet.validations };
    for (const key of rangeKeys(selection)) {
      if (validation) validations[key] = validation;
      else delete validations[key];
    }
    updateSheet({ ...sheet, validations: Object.keys(validations).length ? validations : undefined });
  }

  function setCellType(type: SheetCellType) {
    const styles = { ...sheet.styles };
    const validations = { ...sheet.validations };
    for (const key of rangeKeys(selection)) {
      const style: CellStyle = {
        ...styles[key],
        numberFormat: type === "date" ? "date" : undefined,
        decimals: undefined,
      };
      if (Object.values(style).some((value) => value !== undefined)) styles[key] = style;
      else delete styles[key];
      if (type === "checkbox") validations[key] = { type: "checkbox" };
      else delete validations[key];
    }
    updateSheet({
      ...sheet,
      styles: Object.keys(styles).length ? styles : undefined,
      validations: Object.keys(validations).length ? validations : undefined,
    });
  }

  function setCheckboxes(checked: boolean) {
    const cells = { ...sheet.cells };
    for (const key of rangeKeys(selection)) {
      if (sheet.validations?.[key]?.type === "checkbox") cells[key] = checked ? "TRUE" : "FALSE";
    }
    updateSheet({ ...sheet, cells });
  }

  function insertCalculation(operation: SheetCalculation) {
    const { start, end } = selection;
    let firstRow = start.row;
    let lastRow = end.row;
    if (selectionLabel === selectedKey && !raw) {
      lastRow = selected.row - 1;
      firstRow = lastRow;
      while (firstRow > 1 && sheet.cells[cellKey({ row: firstRow - 1, col: selected.col })]) firstRow -= 1;
      if (lastRow < 1 || !sheet.cells[cellKey({ row: lastRow, col: selected.col })]) {
        toast.error("Select values to calculate.");
        return;
      }
    }
    const targetRow = lastRow + 1;
    if (targetRow > SHEET_ROWS) {
      toast.error("Leave an empty row below the selection for the result.");
      return;
    }
    const cells = { ...sheet.cells };
    for (let col = start.col; col <= end.col; col += 1) {
      const target = cellKey({ row: targetRow, col });
      if (cells[target] || sheet.validations?.[target]) {
        toast.error(`${target} needs to be empty and have no validation.`);
        return;
      }
      const range = rangeLabel(cellRange({ row: firstRow, col }, { row: lastRow, col }));
      cells[target] = `=${operation}(${range})`;
    }
    updateSheet({ ...sheet, cells });
    move(targetRow, start.col);
  }

  function addChart(next: SheetChart) {
    updateSheet({ ...sheet, charts: [...charts, next] });
    setChartIndex(charts.length);
  }

  function removeChart(index: number) {
    updateSheet({ ...sheet, charts: charts.filter((_, candidate) => index !== candidate) });
    setChartIndex(charts.length > 1 ? Math.max(0, index - 1) : null);
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
    if (event.key === "Escape" && selectionOrigin) {
      event.preventDefault();
      setSelectionOrigin(null);
      return;
    }
    if (event.code === "Space" && (event.shiftKey || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (event.shiftKey) selectRow(row);
      else selectColumn(col);
      return;
    }
    const viewportHeight = (viewportRef.current?.clientHeight ?? 520) / zoomScale;
    const nextByKey: Record<string, CellAddress> = {
      ArrowUp: { row: row - 1, col },
      ArrowDown: { row: row + 1, col },
      ArrowLeft: { row, col: col - 1 },
      ArrowRight: { row, col: col + 1 },
      Home: { row: event.ctrlKey || event.metaKey ? 1 : row, col: 1 },
      End: { row: event.ctrlKey || event.metaKey ? bounds.row : row, col: bounds.col },
      PageUp: { row: rowAt(rowOffsets, rowOffsets[row - 1] - viewportHeight), col },
      PageDown: { row: rowAt(rowOffsets, rowOffsets[row - 1] + viewportHeight), col },
    };
    const next = nextByKey[event.key];
    if (next) {
      event.preventDefault();
      move(next.row, next.col, event.shiftKey);
      return;
    }
    if (onChange && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      const shortcut = event.key.toLowerCase();
      const key = shortcut === "b" ? "bold" : shortcut === "i" ? "italic" : shortcut === "u" ? "underline" : undefined;
      if (key) {
        event.preventDefault();
        setStyle({ [key]: selectedStyle[key] ? undefined : true });
        return;
      }
    }
    if (!onChange || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
    if (event.code === "Space" && selectedValidation?.type === "checkbox") {
      event.preventDefault();
      const checked = getValue(sheet.name, selectedKey).value === true;
      setCell(selectedKey, checked ? "FALSE" : "TRUE");
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      const cells = { ...sheet.cells };
      for (const key of rangeKeys(selection)) delete cells[key];
      updateSheet({ ...sheet, cells });
    } else if (event.key === "Enter" || event.key === "F2" || event.key.length === 1) {
      event.preventDefault();
      setSelectionOrigin(null);
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
    const text = event.clipboardData.getData("text/plain");
    const cells = { ...sheet.cells };
    const { start } = selection;
    const lines = parseSheetRows(text, "\t", SHEET_ROWS - start.row + 1, SHEET_COLUMNS - start.col + 1);
    for (const [rowOffset, values] of lines.entries()) {
      for (const [colOffset, value] of values.entries()) {
        const key = cellKey({ row: start.row + rowOffset, col: start.col + colOffset });
        if (!acceptsCellValue(value, sheet.validations?.[key])) {
          toast.error(`The pasted value is invalid for ${key}.`);
          return;
        }
        if (value === "") delete cells[key];
        else cells[key] = value;
      }
    }
    updateSheet({ ...sheet, cells });
  }

  function copyCells(event: ClipboardEvent<HTMLTableCellElement>) {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    const { start, end } = selection;
    const rows: string[] = [];
    for (let row = start.row; row <= end.row; row += 1) {
      const values: string[] = [];
      for (let col = start.col; col <= end.col; col += 1) {
        const key = cellKey({ row, col });
        const display = formattedSheetValue(getValue(sheet.name, key), sheet.styles?.[key]);
        values.push(/["\t\r\n]/.test(display) ? '"' + display.replaceAll('"', '""') + '"' : display);
      }
      rows.push(values.join("\t"));
    }
    event.clipboardData.setData("text/plain", rows.join("\n"));
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
    setSelectionOrigin(null);
    setChartIndex(null);
    resetViewport();
  }

  async function downloadWorkbook() {
    setExporting(true);
    try {
      const { buildWorkbookXlsx } = await import("./artifact-sheets-export");
      saveFile(await buildWorkbookXlsx(workbook, getValue), "workbook.xlsx");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not export workbook");
    } finally {
      setExporting(false);
    }
  }

  async function importWorkbook(file: File) {
    const request = ++importEpoch.current;
    setImporting(true);
    try {
      const { appendImportedSheets, readWorksheetFile } = await import("./artifact-sheets-import");
      const imported = await readWorksheetFile(file);
      if (request !== importEpoch.current) return;
      const { workbook: latest, onChange: apply } = liveWorkbook.current;
      const firstAdded = latest.sheets.length;
      if (!imported.length) throw new Error("The file has no visible worksheets.");
      if (latest.sheets.length + imported.length > WORKBOOK_SHEETS) throw new Error(`A workbook can have up to ${WORKBOOK_SHEETS} worksheets.`);
      const sheets = appendImportedSheets(latest.sheets, imported);
      const next = JSON.stringify({ ...latest, sheets }, null, 2);
      if (new TextEncoder().encode(next).length > MAX_ARTIFACT_BYTES) throw new Error("This import would exceed the artifact size limit.");
      if (!apply) return;
      apply(next);
      setSheetIndex(firstAdded);
      setSelected(FIRST_CELL);
      setSelectionOrigin(null);
      setChartIndex(null);
      resetViewport();
    } catch (error) {
      if (request === importEpoch.current) toast.error(error instanceof Error ? error.message : "Could not import the workbook");
    } finally {
      if (request === importEpoch.current) setImporting(false);
    }
  }

  function moveWorksheet(direction: -1 | 1) {
    const destination = activeIndex + direction;
    if (destination < 0 || destination >= workbook.sheets.length) return;
    const sheets = [...workbook.sheets];
    [sheets[activeIndex], sheets[destination]] = [sheets[destination], sheets[activeIndex]];
    onChange?.(JSON.stringify({ ...workbook, sheets }, null, 2));
    setSheetIndex(destination);
  }

  function downloadCsv() {
    const filename = sheet.name.trim().replace(/[^a-z0-9 -]/gi, "").replace(/\s+/g, "-") || "sheet";
    saveFile(new Blob(["\uFEFF", sheetCsv(sheet, getValue)], { type: "text/csv;charset=utf-8" }), `${filename}.csv`);
  }

  const moreMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" aria-label="More" title="More"><MoreHorizontal aria-hidden="true" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={onChange ? "top" : "bottom"}>
        {onChange && <DropdownMenuItem disabled={importing} onSelect={() => importRef.current?.click()}>
          <FileUp aria-hidden="true" />{importing ? "Importing…" : "Import CSV or XLSX"}
        </DropdownMenuItem>}
        <DropdownMenuItem disabled={exporting} onSelect={() => void downloadWorkbook()}>
          <Download aria-hidden="true" />{exporting ? "Exporting…" : "Export workbook as XLSX"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={downloadCsv}><Download aria-hidden="true" />Export worksheet as CSV</DropdownMenuItem>
        {charts.length > 0 && <DropdownMenuItem onSelect={() => setChartIndex(chart ? null : 0)}>
          <ChartNoAxesColumn aria-hidden="true" />{chart ? "Hide charts" : "Show charts"}
        </DropdownMenuItem>}
        {onChange && <>
          <DropdownMenuSeparator />
          <SheetFormattingMenu style={selectedStyle} onChange={setStyle} onClear={() => setStyle(null)} />
          {workbook.sheets.length > 1 && <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={activeIndex === 0} onSelect={() => moveWorksheet(-1)}><MoveLeft aria-hidden="true" />Move worksheet left</DropdownMenuItem>
            <DropdownMenuItem disabled={activeIndex === workbook.sheets.length - 1} onSelect={() => moveWorksheet(1)}><MoveRight aria-hidden="true" />Move worksheet right</DropdownMenuItem>
          </>}
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <section aria-label="Spreadsheet" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      {onChange && <input ref={importRef} type="file" accept=".csv,.xlsx" className="hidden" aria-label="Upload worksheet"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void importWorkbook(file);
        }} />}
      <div data-slot="sheet-formula-bar" className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-card px-2">
        {onChange ? <SheetFunctionMenu onCalculate={insertCalculation} /> : <FunctionSquare aria-hidden="true" className="mx-2 size-4 shrink-0 text-muted-foreground" />}
        <span className="sr-only" aria-label="Selected range">{selectionLabel}</span>
        <Input
          aria-label="Formula bar"
          className="h-7 min-w-0 flex-1 rounded-sm border-transparent bg-transparent px-2 font-mono text-xs shadow-none"
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="xs" variant="ghost" aria-label={`${zoom}%, Zoom`} title="Zoom" className="h-7 min-w-16 tabular-nums">
              {zoom}%<ChevronDown aria-hidden="true" className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={String(zoom)} onValueChange={(value) => changeZoom(Number(value))}>
              {ZOOM_LEVELS.map((level) => <DropdownMenuRadioItem value={String(level)} key={level}>{level}%</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {onShowHistory && <Button type="button" size="icon-xs" variant="ghost" aria-label="Version history" title="Version history" onClick={onShowHistory}>
          <History aria-hidden="true" />
        </Button>}
        {!onChange && moreMenu}
      </div>

      {streaming && <p className="sr-only" role="status">{product} is writing spreadsheet cells.</p>}
      <div className="relative isolate min-h-0 flex-1 overflow-hidden">
        <div ref={viewportRef} data-slot="sheet-grid-viewport" className="absolute inset-0 overflow-auto [overflow-anchor:none]"
          onScroll={(event) => updateViewport(event.currentTarget)}>
          <table role="grid" aria-label={sheet.name} aria-rowcount={SHEET_ROWS + 1} aria-colcount={SHEET_COLUMNS + 1}
            aria-readonly={!onChange} aria-multiselectable="true" className="w-max min-w-full select-none border-separate border-spacing-0 text-xs"
            style={zoom === 100 ? undefined : { zoom: zoomScale, minWidth: `${100 / zoomScale}%` }}
            tabIndex={selected.row < rowsStart || selected.row > rowsEnd ? 0 : undefined}
            onFocus={(event) => {
              if (event.target === event.currentTarget) move(rowAt(rowOffsets, (viewportRef.current?.scrollTop ?? 0) / zoomScale), selected.col);
            }}
            onPointerUp={() => { selectionGesture.current = false; }}>
            <thead className="sticky top-0 z-20 bg-muted">
              <tr aria-rowindex={1}>
                <th className="sticky left-0 w-10 min-w-10 border-b border-r border-border bg-muted" scope="col" aria-label="Rows" />
                {Array.from({ length: columns }, (_, index) => (
                  <th key={index} scope="col" className={cn(
                    "h-6 min-w-[5.5rem] cursor-s-resize border-b border-r border-border px-2 text-center font-mono text-[11px] font-medium text-muted-foreground",
                    index + 1 >= selection.start.col && index + 1 <= selection.end.col && "bg-primary/10 text-primary",
                  )} onClick={() => selectColumn(index + 1)}>{columnLabel(index + 1)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowsStart > 1 && <tr aria-hidden="true"><td colSpan={columns + 1} className="p-0" style={{ height: rowOffsets[rowsStart - 1] }} /></tr>}
              {Array.from({ length: rowsEnd - rowsStart + 1 }, (_, rowOffset) => {
                const row = rowsStart + rowOffset;
                const height = rowOffsets[row] - rowOffsets[row - 1];
                return (
                  <tr key={row} aria-rowindex={row + 1} style={height === ROW_HEIGHT ? undefined : { height }}>
                    <th scope="row" className={cn(
                      "sticky left-0 z-10 h-[26px] cursor-e-resize border-b border-r border-border bg-muted px-1.5 text-right font-mono text-[11px] font-normal text-muted-foreground",
                      row >= selection.start.row && row <= selection.end.row && "bg-accent text-primary",
                    )} onClick={() => selectRow(row)}>{row}</th>
                    {Array.from({ length: columns }, (_, index) => {
                      const col = index + 1;
                      const key = cellKey({ row, col });
                      const active = selected.row === row && selected.col === col;
                      const inSelection = rangeContains(selection, row, col);
                      const result = getValue(sheet.name, key);
                      const cellStyle = sheet.styles?.[key];
                      const validation = sheet.validations?.[key];
                      const conditionalFill = ruleRanges.find(({ rule, range }) =>
                        rangeContains(range, row, col) && matchesSheetRule(rule, result.value))?.rule.fill;
                      const fill = conditionalFill ?? cellStyle?.fill;
                      const border = cellStyle?.border;
                      const borderColor = "var(--muted-foreground)";
                      const display = formattedSheetValue(result, cellStyle);
                      const useCheckbox = validation?.type === "checkbox" && (result.value === null || typeof result.value === "boolean");
                      return (
                        <td
                          key={key}
                          role="gridcell"
                          aria-label={display ? `${key}: ${display}` : key}
                          aria-selected={inSelection}
                          tabIndex={active ? 0 : -1}
                          ref={active ? selectedRef : undefined}
                          className={cn(
                            "relative h-[26px] max-w-32 min-w-[5.5rem] cursor-cell border-b border-r border-border/75 p-0 outline-none hover:bg-muted/35",
                            inSelection && "bg-primary/10",
                            active && "bg-primary/5 ring-1 ring-inset ring-primary",
                          )}
                          style={{
                            backgroundColor: fill,
                            borderTop: border === "all" || border === "top" ? `1px solid ${borderColor}` : undefined,
                            borderLeft: border === "all" || border === "left" ? `1px solid ${borderColor}` : undefined,
                            borderBottomColor: border === "all" || border === "bottom" ? borderColor : undefined,
                            borderRightColor: border === "all" || border === "right" ? borderColor : undefined,
                          }}
                          onPointerDown={(event) => beginSelection(event, row, col)}
                          onPointerEnter={(event) => { if (selectionGesture.current && (event.buttons & 1) && !active) move(row, col, true); }}
                          onPointerCancel={() => { selectionGesture.current = false; }}
                          onDoubleClick={() => {
                            if (onChange && active) {
                              setSelectionOrigin(null);
                              setEdit(raw);
                            }
                          }}
                          onKeyDown={handleGridKey}
                          onPaste={pasteCells}
                          onCopy={copyCells}
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
                          ) : useCheckbox ? (
                            <div className="flex h-6 items-center px-2" data-sheet-value={display ? key : undefined}>
                              <input type="checkbox" aria-label={`Checkbox ${key}`} className="size-4 accent-primary"
                                tabIndex={active ? 0 : -1} checked={result.value === true} disabled={!onChange}
                                onChange={(event) => setCell(key, event.target.checked ? "TRUE" : "FALSE")} />
                            </div>
                          ) : validation?.type === "list" ? (
                            <select aria-label={`Dropdown ${key}`} data-sheet-value={display ? key : undefined} tabIndex={active ? 0 : -1} value={sheet.cells[key] ?? ""}
                              disabled={!onChange} onChange={(event) => setCell(key, event.target.value)}
                              className="h-6 w-full min-w-0 bg-transparent px-2 text-inherit">
                              <option value="" />
                              {sheet.cells[key] && !validation.options.includes(sheet.cells[key])
                                && <option value={sheet.cells[key]} disabled>{sheet.cells[key]}</option>}
                              {validation.options.map((option) => <option key={option} value={option}>{option}</option>)}
                            </select>
                          ) : (
                            <span data-sheet-value={display ? key : undefined} title={display || undefined} className={cn(
                              "block h-6 max-w-32 truncate px-2 leading-6",
                              typeof result.value === "number" && "text-right tabular-nums",
                              result.error && "text-destructive",
                              cellStyle?.bold && "font-bold",
                              cellStyle?.italic && "italic",
                              cellStyle?.underline && "underline",
                            )} style={{
                              textAlign: cellStyle?.align,
                              color: result.error ? undefined : cellStyle?.color,
                              fontSize: cellStyle?.fontSize,
                              ...(height > ROW_HEIGHT ? { height: height - 2, lineHeight: `${height - 2}px` } : {}),
                            }}>{display}</span>
                          )}
                          <span aria-hidden="true" data-sheet-outline
                            className="pointer-events-none absolute inset-0 z-1 rounded-[1px] border border-primary opacity-0 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_22%,transparent)]" />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {rowsEnd < SHEET_ROWS && <tr aria-hidden="true"><td colSpan={columns + 1} className="p-0" style={{ height: rowOffsets[SHEET_ROWS] - rowOffsets[rowsEnd] }} /></tr>}
            </tbody>
          </table>
        </div>
        <div ref={sweepRef} aria-hidden="true" className="pointer-events-none absolute left-10 right-0 top-0 z-10 h-8 border-t border-primary/35 opacity-0"
          style={{ background: "linear-gradient(to bottom, color-mix(in oklab, var(--primary) 15%, transparent), transparent)" }} />
        <div ref={badgeRef} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 z-30 max-w-40 truncate rounded-control bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground opacity-0">
          {product}
        </div>
        {onChange && <SheetFormatBar style={selectedStyle} onChange={setStyle}>
          <SheetDataTools range={selectionLabel} validation={selectedValidation} rules={rules} chartCount={charts.length}
            cellType={cellType} onType={setCellType} onValidation={setValidation} onCheckboxes={setCheckboxes}
            onRules={(next) => updateSheet({ ...sheet, rules: next })} onChart={addChart}>
            <SheetFontMenu style={selectedStyle} onChange={setStyle} />
          </SheetDataTools>
          <div className="border-l border-border pl-1">{moreMenu}</div>
        </SheetFormatBar>}
        {chart && (
          <div className="absolute inset-x-2 bottom-14 z-40 rounded-control border border-border bg-popover shadow-raised sm:left-auto sm:right-4 sm:w-96"
            role="region" aria-label="Worksheet chart">
            <div className="flex items-center gap-2 px-3 pt-1.5">
              <select aria-label="Active chart" className="min-w-0 flex-1 truncate rounded-control bg-background px-1.5 py-1 text-xs"
                value={chartIndex ?? 0} onChange={(event) => setChartIndex(Number(event.target.value))}>
                {charts.map((item, index) => <option key={index} value={index}>{item.title}</option>)}
              </select>
              <span className="font-mono text-caption text-muted-foreground">{chart.range}</span>
              {onChange && <Button type="button" size="icon-xs" variant="ghost" aria-label="Remove chart" title="Remove chart"
                onClick={() => removeChart(chartIndex ?? 0)}><Trash2 aria-hidden="true" /></Button>}
              <Button type="button" size="icon-xs" variant="ghost" aria-label="Hide chart" title="Hide chart"
                onClick={() => setChartIndex(null)}><X aria-hidden="true" /></Button>
            </div>
            <Suspense fallback={<p className="p-3 text-sm text-muted-foreground">Loading chart…</p>}>
              <SheetChartPreview chart={chart} sheetName={sheet.name} getValue={getValue} />
            </Suspense>
          </div>
        )}
      </div>
      <div data-slot="sheet-tabs" className="flex h-9 shrink-0 items-center gap-1.5 border-t border-border bg-card px-2">
        {onChange && (
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Add worksheet" title="Add worksheet"
            disabled={workbook.sheets.length >= WORKBOOK_SHEETS} onClick={addSheet}>
            <Plus aria-hidden="true" />
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="xs" variant="ghost" aria-label="All worksheets" title="All worksheets">
              <List aria-hidden="true" /><ChevronDown aria-hidden="true" className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuRadioGroup value={String(activeIndex)} onValueChange={(value) => selectWorksheet(Number(value))}>
              {workbook.sheets.map((item, index) => <DropdownMenuRadioItem key={item.name} value={String(index)}>{item.name}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-auto border-l border-border pl-1.5 [scrollbar-width:none]" role="group" aria-label="Worksheets">
          {workbook.sheets.map((item, index) => (
            <Button key={item.name} type="button" size="xs" className="relative h-7" variant={index === activeIndex ? "secondary" : "ghost"}
              aria-pressed={index === activeIndex} onClick={() => selectWorksheet(index)}>{item.name}{streaming && index === activeIndex &&
                <span aria-hidden="true" className="absolute inset-x-1 bottom-0 h-px bg-primary motion-safe:animate-pulse" />}</Button>
          ))}
        </div>
      </div>
    </section>
  );
}
