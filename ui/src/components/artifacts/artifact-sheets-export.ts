import { SHEET_EXPORT_BORDER_ARGB } from "./artifact-content-palette";
import { isSupportedFormula } from "./artifact-sheets-formulas";
import { cellKey, readRange, sheetDate, xlsxNumberFormat, type RuleOperator, type SheetValue, type Workbook } from "./artifact-sheets-model";

const ruleSymbols: Record<RuleOperator, string> = {
  greaterThan: ">", lessThan: "<", equal: "=", notEqual: "<>", greaterThanOrEqual: ">=", lessThanOrEqual: "<=",
};

export async function buildWorkbookXlsx(workbook: Workbook, get: (sheetName: string, key: string) => SheetValue): Promise<Blob> {
  const { default: excel } = await import("exceljs");
  const output = new excel.Workbook();
  const sheets = workbook.sheets.map((sheet) => output.addWorksheet(sheet.name));
  let validationSheet: ReturnType<typeof output.addWorksheet> | null = null;
  let nextOptionRow = 1;
  const validationNames = new Map<string, string>();

  function listName(options: string[]) {
    const signature = JSON.stringify(options);
    const cached = validationNames.get(signature);
    if (cached) return cached;
    if (!validationSheet) {
      const names = new Set(workbook.sheets.map((sheet) => sheet.name.toLowerCase()));
      let name = "_Polpo choices";
      for (let suffix = 2; names.has(name.toLowerCase()); suffix += 1) name = `_Polpo choices ${suffix}`;
      validationSheet = output.addWorksheet(name, { state: "veryHidden" });
    }
    const first = nextOptionRow;
    for (const option of options) validationSheet.getCell(nextOptionRow++, 1).value = option;
    const name = `Polpo_Choices_${validationNames.size + 1}`;
    output.definedNames.add(`'${validationSheet.name}'!$A$${first}:$A$${nextOptionRow - 1}`, name);
    validationNames.set(signature, name);
    return name;
  }

  workbook.sheets.forEach((sheet, index) => {
    const worksheet = sheets[index];
    const addresses = new Set([...Object.keys(sheet.cells), ...Object.keys(sheet.styles ?? {}), ...Object.keys(sheet.validations ?? {})]);
    for (const address of addresses) {
      const raw = sheet.cells[address];
      const result = get(sheet.name, address);
      const cell = worksheet.getCell(address);
      const validation = sheet.validations?.[address];
      const style = sheet.styles?.[address];
      const date = style?.numberFormat === "date" && validation?.type !== "list" && typeof result.value === "string"
        ? sheetDate(result.value) : undefined;
      cell.value = raw?.startsWith("=") && !result.error && isSupportedFormula(raw)
        ? { formula: raw.slice(1), result: result.value ?? undefined }
        : result.error ?? date ?? result.value;
      if (validation?.type === "list") cell.dataValidation = {
        type: "list", allowBlank: true, showErrorMessage: true, formulae: [listName(validation.options)],
      };
      if (!style) continue;
      cell.font = {
        ...cell.font,
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        ...(style.fontSize ? { size: style.fontSize * 0.75 } : {}),
        ...(style.color ? { color: { argb: "FF" + style.color.slice(1).toUpperCase() } } : {}),
      };
      if (style.align) cell.alignment = { horizontal: style.align };
      if (style.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + style.fill.slice(1).toUpperCase() } };
      if (style.border) {
        const border = { style: "thin" as const, color: { argb: SHEET_EXPORT_BORDER_ARGB } };
        cell.border = style.border === "all" ? { top: border, right: border, bottom: border, left: border } : { [style.border]: border };
      }
      const numberFormat = xlsxNumberFormat(style);
      if (numberFormat) cell.numFmt = numberFormat;
    }
    sheet.rules?.forEach((rule, priority) => {
      const range = readRange(rule.range);
      if (!range) return;
      const first = cellKey(range.start);
      worksheet.addConditionalFormatting({
        ref: first + ":" + cellKey(range.end),
        rules: [{
          type: "expression",
          formulae: [`AND(ISNUMBER(${first}),${first}${ruleSymbols[rule.operator]}${rule.value})`],
          priority: priority + 1,
          style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + rule.fill.slice(1).toUpperCase() } } },
        }],
      });
    });
  });

  const buffer = await output.xlsx.writeBuffer();
  return new Blob([new Uint8Array(buffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
