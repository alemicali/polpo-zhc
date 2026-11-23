export const SHEET_ROWS = 500;
export const SHEET_COLUMNS = 52;
export const WORKBOOK_SHEETS = 20;
export const MAX_CELL_DECIMALS = 8;

export type CellAddress = { row: number; col: number };
export type CellStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right";
  color?: string;
  fill?: string;
  numberFormat?: "currency" | "percent";
  decimals?: number;
};
export type Sheet = { name: string; cells: Record<string, string>; styles?: Record<string, CellStyle> };
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

function isCellStyle(style: CellStyle | null): boolean {
  if (!style || typeof style !== "object" || Array.isArray(style)) return false;
  return ([style.bold, style.italic, style.underline].every((flag) => flag === undefined || typeof flag === "boolean"))
    && (style.align === undefined || ["left", "center", "right"].includes(style.align))
    && [style.color, style.fill].every((color) => color === undefined || (typeof color === "string" && /^#[a-f0-9]{6}$/i.test(color)))
    && (style.numberFormat === undefined || ["currency", "percent"].includes(style.numberFormat))
    && (style.decimals === undefined || (Number.isInteger(style.decimals) && style.decimals >= 0 && style.decimals <= MAX_CELL_DECIMALS));
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
      if (sheet.styles !== undefined && (!sheet.styles || typeof sheet.styles !== "object" || Array.isArray(sheet.styles)
        || Object.entries(sheet.styles).some(([key, style]) => !cellAddress(key) || !isCellStyle(style)))) return null;
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

const numberFormats = new Map<string, Intl.NumberFormat>();

export function formattedSheetValue(result: SheetValue, style?: CellStyle): string {
  if (typeof result.value !== "number" || (!style?.numberFormat && style?.decimals === undefined)) return displaySheetValue(result);
  const decimals = style.decimals ?? 2;
  const mode = style.numberFormat ?? "decimal";
  const key = mode + decimals;
  let formatter = numberFormats.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(undefined, {
      style: mode,
      ...(mode === "currency" ? { currency: "EUR" } : {}),
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    numberFormats.set(key, formatter);
  }
  return formatter.format(result.value);
}

export function xlsxNumberFormat(style: CellStyle): string | undefined {
  if (style.numberFormat === undefined && style.decimals === undefined) return;
  const decimals = style.decimals ?? 2;
  const number = "#,##0" + (decimals > 0 ? "." + "0".repeat(decimals) : "");
  if (style.numberFormat === "currency") return number + ' "€"';
  return number + (style.numberFormat === "percent" ? "%" : "");
}

export function sheetBounds(sheet: Sheet, includeStyles = true): CellAddress {
  let row = 1;
  let col = 1;
  const keys = Object.keys(sheet.cells);
  if (includeStyles && sheet.styles) keys.push(...Object.keys(sheet.styles));
  for (const key of keys) {
    const address = cellAddress(key);
    if (!address) continue;
    row = Math.max(row, address.row);
    col = Math.max(col, address.col);
  }
  return { row, col };
}

export function sheetCsv(sheet: Sheet, get: (sheetName: string, key: string) => SheetValue): string {
  const { row, col } = sheetBounds(sheet, false);
  return Array.from({ length: row }, (_, rowIndex) =>
    Array.from({ length: col }, (_, colIndex) => {
      const result = get(sheet.name, cellKey({ row: rowIndex + 1, col: colIndex + 1 }));
      let text = displaySheetValue(result);
      if (typeof result.value === "string" && /^[\t\r\n ]*[=+\-@＝＋－＠]/.test(text)) text = "'" + text;
      return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
    }).join(",")).join("\r\n");
}
