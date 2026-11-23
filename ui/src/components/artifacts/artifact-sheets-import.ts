import { cellKey, parseSheetRows, SHEET_COLUMNS, SHEET_ROWS, type CellStyle, type Sheet } from "./artifact-sheets-model";

export function availableSheetName(proposed: string, current: Sheet[]): string {
  const used = new Set(current.map((sheet) => sheet.name.toLowerCase()));
  const base = proposed.replace(/[\\/?*:[\]]/g, " ").trim().replace(/^'+|'+$/g, "").trim() || "Sheet";
  let name = base.slice(0, 31).replace(/'+$/g, "").trimEnd();
  for (let suffix = 2; used.has(name.toLowerCase()); suffix += 1) {
    const marker = " " + suffix;
    name = base.slice(0, 31 - marker.length) + marker;
  }
  return name;
}

export function appendImportedSheets(current: Sheet[], imported: Sheet[]): Sheet[] {
  const sheets = [...current];
  const renamed = new Map<string, string>();
  const additions = imported.map((sheet) => {
    const name = availableSheetName(sheet.name, sheets);
    if (name !== sheet.name) renamed.set(sheet.name.toLowerCase(), name);
    const added = { ...sheet, name, cells: { ...sheet.cells } };
    sheets.push(added);
    return added;
  });
  if (!renamed.size) return sheets;
  for (const sheet of additions) {
    for (const [key, raw] of Object.entries(sheet.cells)) {
      if (!raw.startsWith("=")) continue;
      sheet.cells[key] = raw.replace(/"(?:[^"]|"")*"|('(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.]*)!/g, (match, token?: string) => {
        if (!token) return match;
        const from = token.startsWith("'") ? token.slice(1, -1).replaceAll("''", "'") : token;
        const to = renamed.get(from.toLowerCase());
        return to ? "'" + to.replaceAll("'", "''") + "'!" : match;
      });
    }
  }
  return sheets;
}

export async function readWorksheetFile(file: File): Promise<Sheet[]> {
  if (/\.csv$/i.test(file.name)) {
    const cells: Record<string, string> = {};
    parseSheetRows(await file.text(), ",").forEach((row, rowIndex) => {
      row.forEach((value, colIndex) => {
        if (value) cells[cellKey({ row: rowIndex + 1, col: colIndex + 1 })] = value;
      });
    });
    return [{ name: file.name.replace(/\.csv$/i, ""), cells }];
  }
  if (!/\.xlsx$/i.test(file.name)) throw new Error("Choose a CSV or XLSX spreadsheet.");

  const data = await file.arrayBuffer();
  checkZipSize(data);
  const { default: excel } = await import("exceljs");
  const workbook = new excel.Workbook();
  await workbook.xlsx.load(data);
  return workbook.worksheets.filter((worksheet) => worksheet.state === "visible").map((worksheet) => {
    const cells: Record<string, string> = {};
    const styles: Record<string, CellStyle> = {};
    worksheet.eachRow((row, rowIndex) => {
      if (rowIndex > SHEET_ROWS) return;
      row.eachCell((cell, colIndex) => {
        if (colIndex > SHEET_COLUMNS) return;
        const key = cellKey({ row: rowIndex, col: colIndex });
        const value = cell.value;
        if (value === null || value === undefined) return;
        const style: CellStyle = {};
        if (cell.formula) cells[key] = "=" + cell.formula;
        else if (value instanceof Date && Number.isFinite(value.valueOf())) {
          cells[key] = value.toISOString().slice(0, 10);
          style.numberFormat = "date";
        } else if (typeof value === "boolean") cells[key] = value ? "TRUE" : "FALSE";
        else if (typeof value === "string") cells[key] = value.startsWith("=") || value.startsWith("'") ? "'" + value : value;
        else cells[key] = cell.text;
        if (cell.font?.bold) style.bold = true;
        if (cell.font?.italic) style.italic = true;
        if (cell.font?.underline) style.underline = true;
        const fontSize = Math.round((cell.font?.size ?? 0) / 0.75);
        if (fontSize >= 8 && fontSize <= 36) style.fontSize = fontSize;
        const align = cell.alignment?.horizontal;
        if (align === "left" || align === "center" || align === "right") style.align = align;
        const textColor = excelColor(cell.font?.color?.argb);
        if (textColor) style.color = textColor;
        const fill = cell.fill?.type === "pattern" && cell.fill.pattern === "solid" ? excelColor(cell.fill.fgColor?.argb) : undefined;
        if (fill) style.fill = fill;
        if (style.numberFormat !== "date") {
          if (cell.numFmt?.includes("%")) style.numberFormat = "percent";
          else if (cell.numFmt?.includes("€")) style.numberFormat = "currency";
          const decimals = /\.([0#]+)/.exec(cell.numFmt ?? "")?.[1]?.length;
          if (decimals !== undefined && decimals <= 8) style.decimals = decimals;
        }
        if (Object.keys(style).length) styles[key] = style;
      });
    });
    return { name: worksheet.name, cells, ...(Object.keys(styles).length ? { styles } : {}) };
  });
}

function excelColor(argb: string | undefined): string | undefined {
  return argb && /^[a-f0-9]{8}$/i.test(argb) ? "#" + argb.slice(2) : undefined;
}

// Read ZIP directory lengths before ExcelJS inflates the archive.
function checkZipSize(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const end = view.byteLength - 22;
  const earliest = Math.max(0, end - 65_535);
  for (let cursor = end; cursor >= earliest; cursor -= 1) {
    if (view.getUint32(cursor, true) !== 0x06054b50 || cursor + 22 + view.getUint16(cursor + 20, true) !== view.byteLength) continue;
    const entries = view.getUint16(cursor + 10, true);
    const centralSize = view.getUint32(cursor + 12, true);
    let offset = view.getUint32(cursor + 16, true);
    const stop = offset + centralSize;
    if (stop > cursor || entries > 2000) break;
    let bytes = 0;
    for (let index = 0; index < entries; index += 1) {
      if (offset + 46 > stop || view.getUint32(offset, true) !== 0x02014b50) throw new Error("The XLSX file is invalid.");
      bytes += view.getUint32(offset + 24, true);
      if (bytes > 32 * 1024 * 1024) throw new Error("The XLSX workbook is too large to import.");
      offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    }
    if (offset === stop && entries > 0) return;
    break;
  }
  throw new Error("The XLSX file is invalid.");
}
