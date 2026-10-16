/**
 * Deterministic expressions for pipeline guards (`when`) and loop stop
 * conditions (`stopWhen.expression`).
 *
 * A small parser and evaluator — no `eval`, no function calls, no side
 * effects. The only variable is `context`, the pipeline's shared context bag.
 *
 * Grammar:
 *   expr    := or
 *   or      := and ( "||" and )*
 *   and     := not ( "&&" not )*
 *   not     := "!" not | compare
 *   compare := primary ( ( "==" | "!=" | "<" | "<=" | ">" | ">=" ) primary )?
 *   primary := number | string | true | false | null
 *            | path | "(" expr ")"
 *   path    := "context" ( "." ident | "[" ( number | string ) "]" )*
 *
 * Semantics:
 *   - A missing path evaluates to `undefined`; `== null` / `!= null` treat
 *     `undefined` and `null` as equal, so `context.x != null` means "is set".
 *   - `==` / `!=` compare primitives strictly (no type coercion).
 *   - `<`, `<=`, `>`, `>=` only compare two numbers or two strings; any other
 *     pair is false.
 *   - `&&`, `||`, `!` and guard results use JavaScript truthiness.
 */

type Token =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: string };

type Node =
  | { type: "lit"; value: unknown }
  | { type: "path"; segments: (string | number)[] }
  | { type: "not"; operand: Node }
  | { type: "logic"; op: "&&" | "||"; left: Node; right: Node }
  | { type: "cmp"; op: string; left: Node; right: Node };

export class ExpressionError extends Error {
  constructor(message: string, readonly expression: string) {
    super(`${message} in expression: ${expression}`);
    this.name = "ExpressionError";
  }
}

const OPERATORS = ["==", "!=", "<=", ">=", "&&", "||", "<", ">", "!", "(", ")", "[", "]", "."];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }

    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const value = Number(src.slice(i, j));
      if (Number.isNaN(value)) throw new ExpressionError(`Invalid number "${src.slice(i, j)}"`, src);
      tokens.push({ kind: "num", value });
      i = j;
      continue;
    }

    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\" && j + 1 < src.length) { value += src[j + 1]; j += 2; continue; }
        value += src[j++];
      }
      if (j >= src.length) throw new ExpressionError("Unterminated string", src);
      tokens.push({ kind: "str", value });
      i = j + 1;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_$-]/.test(src[j])) j++;
      tokens.push({ kind: "ident", value: src.slice(i, j) });
      i = j;
      continue;
    }

    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExpressionError(`Unexpected character "${ch}"`, src);
    tokens.push({ kind: "op", value: op });
    i += op.length;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[], private readonly src: string) {}

  parse(): Node {
    if (this.tokens.length === 0) throw new ExpressionError("Empty expression", this.src);
    const node = this.or();
    if (this.pos < this.tokens.length) throw new ExpressionError("Unexpected trailing input", this.src);
    return node;
  }

  private peekOp(value: string): boolean {
    const t = this.tokens[this.pos];
    return t?.kind === "op" && t.value === value;
  }

  private expectOp(value: string): void {
    if (!this.peekOp(value)) throw new ExpressionError(`Expected "${value}"`, this.src);
    this.pos++;
  }

  private or(): Node {
    let left = this.and();
    while (this.peekOp("||")) { this.pos++; left = { type: "logic", op: "||", left, right: this.and() }; }
    return left;
  }

  private and(): Node {
    let left = this.not();
    while (this.peekOp("&&")) { this.pos++; left = { type: "logic", op: "&&", left, right: this.not() }; }
    return left;
  }

  private not(): Node {
    if (this.peekOp("!")) { this.pos++; return { type: "not", operand: this.not() }; }
    return this.compare();
  }

  private compare(): Node {
    const left = this.primary();
    const t = this.tokens[this.pos];
    if (t?.kind === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.value)) {
      this.pos++;
      return { type: "cmp", op: t.value, left, right: this.primary() };
    }
    return left;
  }

  private primary(): Node {
    const t = this.tokens[this.pos];
    if (!t) throw new ExpressionError("Unexpected end of expression", this.src);
    if (t.kind === "num" || t.kind === "str") { this.pos++; return { type: "lit", value: t.value }; }
    if (t.kind === "op" && t.value === "(") {
      this.pos++;
      const node = this.or();
      this.expectOp(")");
      return node;
    }
    if (t.kind === "ident") {
      this.pos++;
      if (t.value === "true") return { type: "lit", value: true };
      if (t.value === "false") return { type: "lit", value: false };
      if (t.value === "null") return { type: "lit", value: null };
      if (t.value !== "context") throw new ExpressionError(`Unknown name "${t.value}" (only "context" is available)`, this.src);
      return this.path();
    }
    throw new ExpressionError(`Unexpected "${t.value}"`, this.src);
  }

  private path(): Node {
    const segments: (string | number)[] = [];
    for (;;) {
      if (this.peekOp(".")) {
        this.pos++;
        const t = this.tokens[this.pos++];
        if (t?.kind !== "ident") throw new ExpressionError('Expected a property name after "."', this.src);
        segments.push(t.value);
      } else if (this.peekOp("[")) {
        this.pos++;
        const t = this.tokens[this.pos++];
        if (t?.kind !== "num" && t?.kind !== "str") throw new ExpressionError('Expected a number or string inside "[]"', this.src);
        segments.push(t.value);
        this.expectOp("]");
      } else {
        return { type: "path", segments };
      }
    }
  }
}

function resolvePath(root: unknown, segments: (string | number)[]): unknown {
  let cur = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    // Only own properties: never walk into the prototype chain.
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

function equals(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  return a === b;
}

function evaluate(node: Node, context: unknown): unknown {
  switch (node.type) {
    case "lit": return node.value;
    case "path": return resolvePath(context, node.segments);
    case "not": return !evaluate(node.operand, context);
    case "logic": {
      const left = evaluate(node.left, context);
      if (node.op === "&&") return left ? evaluate(node.right, context) : left;
      return left ? left : evaluate(node.right, context);
    }
    case "cmp": {
      const a = evaluate(node.left, context);
      const b = evaluate(node.right, context);
      if (node.op === "==") return equals(a, b);
      if (node.op === "!=") return !equals(a, b);
      const comparable = (typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string");
      if (!comparable) return false;
      const x = a as number | string;
      const y = b as number | string;
      if (node.op === "<") return x < y;
      if (node.op === "<=") return x <= y;
      if (node.op === ">") return x > y;
      return x >= y;
    }
  }
}

const cache = new Map<string, Node>();

/** Parse an expression, throwing an ExpressionError when it is malformed. */
export function compileExpression(expression: string): Node {
  let node = cache.get(expression);
  if (!node) {
    node = new Parser(tokenize(expression), expression).parse();
    cache.set(expression, node);
  }
  return node;
}

/** Evaluate an expression against the context bag and return its truthiness. */
export function evaluateCondition(expression: string, context: Record<string, unknown>): boolean {
  return Boolean(evaluate(compileExpression(expression), context));
}

/** Evaluate an expression and return its raw value. */
export function evaluateExpression(expression: string, context: Record<string, unknown>): unknown {
  return evaluate(compileExpression(expression), context);
}
