declare module "fast-formula-parser" {
  type Position = { row: number; col: number };
  type Reference = Position & { sheet: string };
  type Range = { sheet: string; from: Position; to: Position };

  class FormulaError extends Error {
    constructor(error: string);
    readonly error: string;
    static readonly REF: FormulaError;
    static readonly VALUE: FormulaError;
    static readonly NUM: FormulaError;
  }

  type Value = number | string | boolean | null | FormulaError;

  export default class FormulaParser {
    static readonly FormulaError: typeof FormulaError;
    readonly functions: Record<string, unknown>;
    constructor(config: {
      onCell: (reference: Reference) => Value;
      onRange: (range: Range) => Value[][];
    });
    parse(formula: string, position: Reference): Value;
  }
}
