import FormulaParser from "fast-formula-parser";
import { cellAddress, cellKey, cellLiteral, SHEET_COLUMNS, SHEET_ROWS, type CellValue, type SheetValue, type Workbook } from "./artifact-sheets-model";

type FormulaValue = ReturnType<FormulaParser["parse"]>;

// Keep evaluation local and limit functions that can expand user-supplied data.
const FUNCTIONS = new Set([
  "ABS", "AND", "AVERAGE", "AVERAGEIF", "AVERAGEIFS", "CEILING", "CHOOSE", "COLUMN", "COLUMNS", "CONCAT",
  "CONCATENATE", "COUNT", "COUNTA", "COUNTBLANK", "COUNTIF", "COUNTIFS", "DATE", "DAY", "FALSE", "FIND", "FLOOR",
  "HLOOKUP", "IF", "IFERROR", "INDEX", "INT", "ISBLANK", "ISERROR", "ISNUMBER", "ISTEXT", "LEFT", "LEN",
  "LOOKUP", "LOWER", "MATCH", "MAX", "MEDIAN", "MID", "MIN", "MOD", "MONTH", "NOT", "OR", "POWER",
  "PRODUCT", "PROPER", "RIGHT", "ROUND", "ROUNDDOWN", "ROUNDUP", "ROW", "ROWS", "SEARCH", "SQRT", "SUBSTITUTE",
  "SUM", "SUMIF", "SUMIFS", "SUMPRODUCT", "TEXT", "TODAY", "TRIM", "TRUE", "UPPER", "VALUE", "VLOOKUP", "YEAR",
]);

const MAX_FORMULA_LENGTH = 2_000;
const MAX_FORMULA_DEPTH = 64;
const { FormulaError } = FormulaParser;
const circularReference = new FormulaError("#CYCLE!");

export function isSupportedFormula(formula: string): boolean {
  const outsideStrings = formula.replace(/"(?:[^"]|"")*"/g, "");
  if (/[|[\]]/.test(outsideStrings)) return false;
  const withoutSheetNames = outsideStrings.replace(/'(?:[^']|'')*'(?=!)/g, "");
  return Array.from(withoutSheetNames.matchAll(/\b([a-z][a-z0-9_.]*)\s*\(/gi))
    .every((match) => FUNCTIONS.has(match[1].toUpperCase()));
}

export function calculateWorkbook(workbook: Workbook): (sheetName: string, key: string) => SheetValue {
  const sheets = new Map(workbook.sheets.map((sheet) => [sheet.name.toLowerCase(), sheet]));
  const evaluated = new Map<string, FormulaValue>();
  const active = new Set<string>();
  const parsers: FormulaParser[] = [];

  function parserAt(depth: number): FormulaParser {
    if (parsers[depth]) return parsers[depth];
    // A formula parser has mutable parsing state. References may evaluate another formula.
    const parser = new FormulaParser({
      onCell: ({ sheet, row, col }) => {
        if (!Number.isInteger(row) || !Number.isInteger(col) || row < 1 || col < 1 || row > SHEET_ROWS || col > SHEET_COLUMNS) {
          return FormulaError.REF;
        }
        return evaluate(sheet, cellKey({ row, col }), depth + 1);
      },
      onRange: ({ sheet, from, to }) => {
        const endRow = Math.min(to.row, SHEET_ROWS);
        const endCol = Math.min(to.col, SHEET_COLUMNS);
        if (from.row < 1 || from.col < 1 || from.row > endRow || from.col > endCol) return [[FormulaError.REF]];
        return Array.from({ length: endRow - from.row + 1 }, (_, row) =>
          Array.from({ length: endCol - from.col + 1 }, (_, col) =>
            evaluate(sheet, cellKey({ row: from.row + row, col: from.col + col }), depth + 1)));
      },
    });
    for (const name of Object.keys(parser.functions)) {
      if (!FUNCTIONS.has(name)) delete parser.functions[name];
    }
    parsers[depth] = parser;
    return parser;
  }

  function evaluate(sheetName: string, key: string, depth: number): FormulaValue {
    const sheet = sheets.get(sheetName?.toLowerCase());
    const position = cellAddress(key);
    if (!sheet || !position) return FormulaError.REF;
    const raw = sheet.cells[key];
    if (!raw?.startsWith("=")) return cellLiteral(raw);
    const identity = sheet.name + "\0" + key;
    const cached = evaluated.get(identity);
    if (cached !== undefined) return cached;
    if (active.has(identity)) return circularReference;
    if (depth >= MAX_FORMULA_DEPTH) return FormulaError.NUM;
    if (raw.length > MAX_FORMULA_LENGTH) return FormulaError.VALUE;
    if (!isSupportedFormula(raw)) return new FormulaError("#NAME?");

    active.add(identity);
    let value: FormulaValue;
    try {
      value = parserAt(depth).parse(raw.slice(1), { ...position, sheet: sheet.name });
    } catch (error) {
      value = error instanceof FormulaError ? error : FormulaError.VALUE;
    } finally {
      active.delete(identity);
    }
    evaluated.set(identity, value);
    return value;
  }

  return (sheetName, key) => {
    const result = evaluate(sheetName, key, 0);
    return result instanceof FormulaError
      ? { value: null, error: result.error === "#ERROR!" ? "#VALUE!" : result.error }
      : { value: result as CellValue };
  };
}
