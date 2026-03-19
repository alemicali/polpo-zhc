/**
 * Excel & CSV tools for spreadsheet operations.
 *
 * Provides tools for agents to:
 * - Read .xlsx files (sheets, rows, cells)
 * - Write/create .xlsx files from structured data
 * - Parse CSV files to structured data
 * - Generate CSV from data
 * - Query and manipulate spreadsheet data
 *
 * Uses `exceljs` for xlsx and built-in logic for CSV.
 * All file operations enforce path sandboxing.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";

const MAX_ROWS_OUTPUT = 200;
const MAX_CELL_LENGTH = 500;

// ─── Tool: excel_read ───

const ExcelReadSchema = Type.Object({
  path: Type.String({ description: "Path to .xlsx or .csv file" }),
  sheet: Type.Optional(Type.Union([
    Type.String(),
    Type.Number(),
  ], { description: "Sheet name or index (0-based). Default: first sheet." })),
  range: Type.Optional(Type.String({ description: "Cell range to read (e.g. 'A1:D10'). Default: all data." })),
  headers: Type.Optional(Type.Boolean({ description: "Treat first row as headers (default: true for CSV)" })),
  max_rows: Type.Optional(Type.Number({ description: "Max rows to return (default: 200)" })),
});

function createExcelReadTool(cwd: string, sandbox: string[]): AgentTool<typeof ExcelReadSchema> {
  return {
    name: "excel_read",
    label: "Read Spreadsheet",
    description: "Read data from an Excel (.xlsx) or CSV file. Returns structured rows with column headers. " +
      "Supports sheet selection and cell range filtering.",
    parameters: ExcelReadSchema,
    async execute(_id, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "excel_read");

      const ext = extname(filePath).toLowerCase();
      const maxRows = params.max_rows ?? MAX_ROWS_OUTPUT;

      try {
        if (ext === ".csv" || ext === ".tsv") {
          return readCsvFile(filePath, ext === ".tsv" ? "\t" : ",", params.headers ?? true, maxRows);
        }

        // Use exceljs for xlsx
        const ExcelJS = await import("exceljs");
        const workbook = new ExcelJS.default.Workbook();
        await workbook.xlsx.readFile(filePath);

        // Select sheet
        let worksheet;
        if (typeof params.sheet === "number") {
          worksheet = workbook.worksheets[params.sheet];
        } else if (typeof params.sheet === "string") {
          worksheet = workbook.getWorksheet(params.sheet);
        } else {
          worksheet = workbook.worksheets[0];
        }

        if (!worksheet) {
          return {
            content: [{ type: "text", text: `Error: sheet not found. Available sheets: ${workbook.worksheets.map(s => s.name).join(", ")}` }],
            details: { error: "sheet_not_found" },
          };
        }

        // Read rows
        const rows: string[][] = [];
        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
          if (rows.length >= maxRows) return;
          const values: string[] = [];
          row.eachCell({ includeEmpty: true }, (cell) => {
            let val = cell.value;
            if (val === null || val === undefined) {
              values.push("");
            } else if (typeof val === "object" && "result" in val) {
              values.push(String((val as any).result ?? ""));
            } else if (typeof val === "object" && "text" in val) {
              values.push(String((val as any).text ?? ""));
            } else {
              values.push(String(val).slice(0, MAX_CELL_LENGTH));
            }
          });
          rows.push(values);
        });

        // Format output
        const sheetNames = workbook.worksheets.map(s => s.name);
        const header = `Sheet: "${worksheet.name}" | Rows: ${worksheet.rowCount} | Cols: ${worksheet.columnCount} | Sheets: [${sheetNames.join(", ")}]`;

        // Format as table
        const table = rows.map((r, i) => `${i + 1}\t${r.join("\t")}`).join("\n");
        const truncated = worksheet.rowCount > maxRows ? `\n... (${worksheet.rowCount - maxRows} more rows)` : "";

        return {
          content: [{ type: "text", text: `${header}\n\n${table}${truncated}` }],
          details: {
            sheet: worksheet.name,
            rows: rows.length,
            totalRows: worksheet.rowCount,
            columns: worksheet.columnCount,
            sheets: sheetNames,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Excel read error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

function readCsvFile(
  filePath: string,
  delimiter: string,
  hasHeaders: boolean,
  maxRows: number,
): AgentToolResult<any> {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter(l => l.trim());

  const rows: string[][] = lines.slice(0, maxRows + (hasHeaders ? 1 : 0))
    .map(line => parseCsvLine(line, delimiter));

  let header = "";
  if (hasHeaders && rows.length > 0) {
    const headers = rows[0];
    header = `Headers: ${headers.join(", ")}\n`;
  }

  const table = rows.map((r, i) => `${i + 1}\t${r.join("\t")}`).join("\n");
  const truncated = lines.length > maxRows ? `\n... (${lines.length - maxRows} more rows)` : "";

  return {
    content: [{ type: "text", text: `CSV: ${lines.length} rows\n${header}\n${table}${truncated}` }],
    details: { rows: rows.length, totalRows: lines.length, format: "csv" },
  };
}

/** Simple CSV line parser handling quoted fields */
function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// ─── Tool: excel_write ───

const ExcelWriteSchema = Type.Object({
  path: Type.String({ description: "Output file path (.xlsx or .csv)" }),
  headers: Type.Array(Type.String(), { description: "Column headers" }),
  rows: Type.Array(
    Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]), { description: "Row values" }),
    { description: "Data rows" },
  ),
  sheet_name: Type.Optional(Type.String({ description: "Sheet name (default: 'Sheet1')" })),
});

function createExcelWriteTool(cwd: string, sandbox: string[]): AgentTool<typeof ExcelWriteSchema> {
  return {
    name: "excel_write",
    label: "Write Spreadsheet",
    description: "Create an Excel (.xlsx) or CSV file from structured data. " +
      "Provide column headers and rows of data.",
    parameters: ExcelWriteSchema,
    async execute(_id, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "excel_write");
      mkdirSync(dirname(filePath), { recursive: true });

      const ext = extname(filePath).toLowerCase();

      try {
        if (ext === ".csv" || ext === ".tsv") {
          const delimiter = ext === ".tsv" ? "\t" : ",";
          const lines = [
            params.headers.map(h => csvEscape(h, delimiter)).join(delimiter),
            ...params.rows.map(row =>
              row.map(v => csvEscape(String(v ?? ""), delimiter)).join(delimiter),
            ),
          ];
          writeFileSync(filePath, lines.join("\n"), "utf-8");
          return {
            content: [{ type: "text", text: `CSV written: ${filePath} (${params.rows.length} rows, ${params.headers.length} columns)` }],
            details: { path: filePath, rows: params.rows.length, format: "csv" },
          };
        }

        // Excel xlsx
        const ExcelJS = await import("exceljs");
        const workbook = new ExcelJS.default.Workbook();
        const sheet = workbook.addWorksheet(params.sheet_name ?? "Sheet1");

        sheet.addRow(params.headers);
        for (const row of params.rows) {
          sheet.addRow(row.map(v => v ?? ""));
        }

        // Auto-width columns
        sheet.columns.forEach((col) => {
          let maxLen = 10;
          col.eachCell?.({ includeEmpty: false }, (cell) => {
            const len = String(cell.value ?? "").length;
            if (len > maxLen) maxLen = Math.min(len, 50);
          });
          col.width = maxLen + 2;
        });

        await workbook.xlsx.writeFile(filePath);
        return {
          content: [{ type: "text", text: `Excel written: ${filePath} (${params.rows.length} rows, ${params.headers.length} columns)` }],
          details: { path: filePath, rows: params.rows.length, format: "xlsx" },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Excel write error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

function csvEscape(value: string, delimiter: string): string {
  if (value.includes(delimiter) || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ─── Tool: excel_query ───

const ExcelQuerySchema = Type.Object({
  path: Type.String({ description: "Path to .xlsx or .csv file" }),
  sheet: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Sheet name or index" })),
  filter_column: Type.Optional(Type.String({ description: "Column header to filter by" })),
  filter_value: Type.Optional(Type.String({ description: "Value to match in the filter column" })),
  sort_column: Type.Optional(Type.String({ description: "Column header to sort by" })),
  sort_desc: Type.Optional(Type.Boolean({ description: "Sort descending (default: ascending)" })),
  columns: Type.Optional(Type.Array(Type.String(), { description: "Select only these columns" })),
  limit: Type.Optional(Type.Number({ description: "Max rows to return" })),
});

function createExcelQueryTool(cwd: string, sandbox: string[]): AgentTool<typeof ExcelQuerySchema> {
  return {
    name: "excel_query",
    label: "Query Spreadsheet",
    description: "Query an Excel or CSV file with filtering, sorting, and column selection. " +
      "Like a simple SELECT with WHERE, ORDER BY, and column projection.",
    parameters: ExcelQuerySchema,
    async execute(_id, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "excel_query");

      try {
        const ext = extname(filePath).toLowerCase();
        let headers: string[] = [];
        let data: Record<string, string>[] = [];

        if (ext === ".csv" || ext === ".tsv") {
          const raw = readFileSync(filePath, "utf-8");
          const lines = raw.split("\n").filter(l => l.trim());
          const delimiter = ext === ".tsv" ? "\t" : ",";
          if (lines.length === 0) {
            return { content: [{ type: "text", text: "Empty file" }], details: { rows: 0 } };
          }
          headers = parseCsvLine(lines[0], delimiter);
          for (let i = 1; i < lines.length; i++) {
            const vals = parseCsvLine(lines[i], delimiter);
            const row: Record<string, string> = {};
            headers.forEach((h, j) => { row[h] = vals[j] ?? ""; });
            data.push(row);
          }
        } else {
          const ExcelJS = await import("exceljs");
          const workbook = new ExcelJS.default.Workbook();
          await workbook.xlsx.readFile(filePath);
          let ws;
          if (typeof params.sheet === "number") ws = workbook.worksheets[params.sheet];
          else if (typeof params.sheet === "string") ws = workbook.getWorksheet(params.sheet);
          else ws = workbook.worksheets[0];
          if (!ws) return { content: [{ type: "text", text: "Sheet not found" }], details: { error: "sheet_not_found" } };

          // Extract headers from first row
          const headerRow = ws.getRow(1);
          headerRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
            headers[colNum - 1] = String(cell.value ?? `Col${colNum}`);
          });

          ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
            if (rowNum === 1) return;
            const record: Record<string, string> = {};
            row.eachCell({ includeEmpty: true }, (cell, colNum) => {
              const val = cell.value;
              record[headers[colNum - 1] ?? `Col${colNum}`] = val === null || val === undefined
                ? ""
                : typeof val === "object" && "result" in val
                  ? String((val as any).result ?? "")
                  : String(val);
            });
            data.push(record);
          });
        }

        // Filter
        if (params.filter_column && params.filter_value !== undefined) {
          data = data.filter(row => {
            const val = row[params.filter_column!] ?? "";
            return val.toLowerCase().includes(params.filter_value!.toLowerCase());
          });
        }

        // Sort
        if (params.sort_column) {
          const col = params.sort_column;
          data.sort((a, b) => {
            const va = a[col] ?? "";
            const vb = b[col] ?? "";
            const numA = Number(va);
            const numB = Number(vb);
            if (!isNaN(numA) && !isNaN(numB)) return params.sort_desc ? numB - numA : numA - numB;
            return params.sort_desc ? vb.localeCompare(va) : va.localeCompare(vb);
          });
        }

        // Column projection
        const selectedCols = params.columns ?? headers;

        // Limit
        const limit = params.limit ?? MAX_ROWS_OUTPUT;
        const limited = data.slice(0, limit);

        // Format
        const table = [
          selectedCols.join("\t"),
          ...limited.map(row => selectedCols.map(c => (row[c] ?? "").slice(0, MAX_CELL_LENGTH)).join("\t")),
        ].join("\n");

        const truncated = data.length > limit ? `\n... (${data.length - limit} more rows)` : "";
        return {
          content: [{ type: "text", text: `${data.length} rows matched:\n\n${table}${truncated}` }],
          details: { matched: data.length, returned: limited.length },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Query error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Tool: excel_info ───

const ExcelInfoSchema = Type.Object({
  path: Type.String({ description: "Path to .xlsx file" }),
});

function createExcelInfoTool(cwd: string, sandbox: string[]): AgentTool<typeof ExcelInfoSchema> {
  return {
    name: "excel_info",
    label: "Spreadsheet Info",
    description: "Get metadata about an Excel file: sheet names, row/column counts, data types.",
    parameters: ExcelInfoSchema,
    async execute(_id, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "excel_info");

      try {
        const ExcelJS = await import("exceljs");
        const workbook = new ExcelJS.default.Workbook();
        await workbook.xlsx.readFile(filePath);

        const sheets = workbook.worksheets.map(ws => ({
          name: ws.name,
          rows: ws.rowCount,
          columns: ws.columnCount,
          state: ws.state,
        }));

        const text = sheets.map(s =>
          `${s.name}: ${s.rows} rows x ${s.columns} cols${s.state !== "visible" ? ` (${s.state})` : ""}`,
        ).join("\n");

        return {
          content: [{ type: "text", text: `${sheets.length} sheet(s):\n${text}` }],
          details: { sheets },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Excel info error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Factory ───

export type ExcelToolName = "excel_read" | "excel_write" | "excel_query" | "excel_info";

export const ALL_EXCEL_TOOL_NAMES: ExcelToolName[] = ["excel_read", "excel_write", "excel_query", "excel_info"];

/**
 * Create Excel/CSV tools.
 *
 * @param cwd - Working directory
 * @param allowedPaths - Sandbox paths
 * @param allowedTools - Optional filter
 */
export function createExcelTools(cwd: string, allowedPaths?: string[], allowedTools?: string[]): AgentTool<any>[] {
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);

  const factories: Record<ExcelToolName, () => AgentTool<any>> = {
    excel_read: () => createExcelReadTool(cwd, sandbox),
    excel_write: () => createExcelWriteTool(cwd, sandbox),
    excel_query: () => createExcelQueryTool(cwd, sandbox),
    excel_info: () => createExcelInfoTool(cwd, sandbox),
  };

  const names = allowedTools
    ? ALL_EXCEL_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_EXCEL_TOOL_NAMES;

  return names.map(n => factories[n]());
}
