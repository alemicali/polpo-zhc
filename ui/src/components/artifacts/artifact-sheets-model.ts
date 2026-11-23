export const SHEET_ROWS = 500;
export const SHEET_COLUMNS = 52;
export const WORKBOOK_SHEETS = 20;

export type CellAddress = { row: number; col: number };
export type Sheet = { name: string; cells: Record<string, string> };
export type Workbook = { version: 1; sheets: Sheet[] };
export type CellValue = string | number | boolean | null;
export type SheetValue = { value: CellValue; error?: string };

export const SHEETS_STARTER = JSON.stringify({
  version: 1,
  sheets: [{ name: "Sheet 1", cells: {} }],
}, null, 2);

export function columnLabel(column: number) {
  let label = "";
  for (let col = column; col > 0; col = Math.floor((col - 1) / 26)) {
    label = String.fromCharCode(65 + (col - 1) % 26) + label;
  }
  return label;
}

export function cellKey({ row, col }: CellAddress): string {
  return columnLabel(col) + row;
}

export function cellAddress(key: string): CellAddress | null {
  const match = /^([A-Z]{1,2})([1-9]\d{0,2})$/.exec(key);
  if (!match) return null;
  const row = Number(match[2]);
  let col = 0;
  for (const letter of match[1]) col = col * 26 + letter.charCodeAt(0) - 64;
  return row <= SHEET_ROWS && col <= SHEET_COLUMNS ? { row, col } : null;
}

export function readWorkbook(content: string): Workbook | null {
  try {
    const workbook = JSON.parse(content) as Workbook;
    if (workbook?.version !== 1 || !Array.isArray(workbook.sheets)
      || workbook.sheets.length < 1 || workbook.sheets.length > WORKBOOK_SHEETS) return null;
    const names = new Set<string>();
    for (const sheet of workbook.sheets) {
      if (typeof sheet?.name !== "string" || !sheet.name.trim() || sheet.name.length > 31
        || /[\\/?*:[\]]/.test(sheet.name) || /^'|'$/.test(sheet.name)
        || names.has(sheet.name.toLowerCase())
        || !sheet.cells || typeof sheet.cells !== "object" || Array.isArray(sheet.cells)) return null;
      names.add(sheet.name.toLowerCase());
      if (Object.entries(sheet.cells).some(([key, raw]) => !cellAddress(key) || typeof raw !== "string")) return null;
    }
    return workbook;
  } catch {
    return null;
  }
}

export function cellLiteral(value: string | undefined): CellValue {
  if (value === undefined || value === "") return null;
  if (value.startsWith("'")) return value.slice(1);
  const text = value.trim();
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) && Number.isFinite(Number(text))) return Number(text);
  if (/^(?:TRUE|FALSE)$/i.test(text)) return text.toUpperCase() === "TRUE";
  return value;
}

export function displaySheetValue({ value, error }: SheetValue) {
  if (error) return error;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return value === null ? "" : String(value);
}

export function sheetBounds(sheet: Sheet): CellAddress {
  let row = 1;
  let col = 1;
  for (const key of Object.keys(sheet.cells)) {
    const address = cellAddress(key);
    if (!address) continue;
    row = Math.max(row, address.row);
    col = Math.max(col, address.col);
  }
  return { row, col };
}

export function sheetCsv(sheet: Sheet, get: (sheetName: string, key: string) => SheetValue): string {
  const { row, col } = sheetBounds(sheet);
  return Array.from({ length: row }, (_, rowIndex) =>
    Array.from({ length: col }, (_, colIndex) => {
      const result = get(sheet.name, cellKey({ row: rowIndex + 1, col: colIndex + 1 }));
      let text = displaySheetValue(result);
      if (typeof result.value === "string" && /^[\t\r\n ]*[=+\-@＝＋－＠]/.test(text)) text = "'" + text;
      return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
    }).join(",")).join("\r\n");
}
