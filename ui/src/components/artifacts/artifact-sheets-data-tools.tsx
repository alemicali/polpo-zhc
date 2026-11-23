import { useState, type FormEvent, type ReactNode } from "react";
import { CalendarDays, ChartNoAxesColumn, ChevronDown, FunctionSquare, ListChecks, Palette, SquareCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { CHART_KINDS, MAX_SHEET_CHARTS, MAX_SHEET_RULES, MAX_VALIDATION_OPTIONS, rangeLabel, readRange, type CellValidation, type RuleOperator, type SheetChart, type SheetRule } from "./artifact-sheets-model";

const operations: Record<RuleOperator, string> = {
  greaterThan: "Greater than",
  lessThan: "Less than",
  equal: "Equals",
  notEqual: "Is not equal to",
  greaterThanOrEqual: "At least",
  lessThanOrEqual: "At most",
};

const chartLabels: Record<SheetChart["kind"], string> = { bar: "Bar", line: "Line", pie: "Pie" };
const controlClass = "w-full rounded-control border border-border bg-background px-3 py-1.5 text-sm";
const calculations = { SUM: "Sum", AVERAGE: "Average", COUNT: "Count numbers", MIN: "Minimum", MAX: "Maximum" } as const;
export type SheetCalculation = keyof typeof calculations;
export type SheetCellType = "automatic" | "date" | "checkbox";

export function SheetDataTools({
  range, validation, rules, chartCount, cellType, onType, onValidation, onCheckboxes, onRules, onChart, children,
}: {
  range: string;
  validation?: CellValidation;
  rules: SheetRule[];
  chartCount: number;
  cellType: SheetCellType;
  onType: (type: SheetCellType) => void;
  onValidation: (validation: CellValidation | null) => void;
  onCheckboxes: (checked: boolean) => void;
  onRules: (rules: SheetRule[]) => void;
  onChart: (chart: SheetChart) => void;
  children: ReactNode;
}) {
  const [mode, setMode] = useState<"dropdown" | "rules" | "chart" | null>(null);
  const list = validation?.type === "list" ? validation.options : [];
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Dialog open={mode === "rules"} onOpenChange={(open) => setMode(open ? "rules" : null)}>
        <DialogTrigger asChild>
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Conditional formatting" title="Conditional formatting">
            <Palette aria-hidden="true" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Conditional formatting</DialogTitle>
            <DialogDescription>Fill cells automatically according to their calculated value.</DialogDescription>
          </DialogHeader>
          <RulesForm range={range} rules={rules} onRules={onRules} />
        </DialogContent>
      </Dialog>
      <Dialog open={mode === "chart"} onOpenChange={(open) => setMode(open ? "chart" : null)}>
        <DialogTrigger asChild>
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Insert chart" title="Insert chart" disabled={chartCount >= MAX_SHEET_CHARTS}>
            <ChartNoAxesColumn aria-hidden="true" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Insert chart</DialogTitle>
            <DialogDescription>Select a range with headings in the first row and labels in the first column.</DialogDescription>
          </DialogHeader>
          <ChartForm range={range} onSave={(chart) => { onChart(chart); setMode(null); }} />
        </DialogContent>
      </Dialog>
      <div className="flex items-center gap-1 border-x border-border px-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="xs" variant={cellType === "automatic" ? "ghost" : "secondary"} aria-label="Cell type" title="Cell type">
              {cellType === "checkbox" ? <SquareCheck aria-hidden="true" /> : cellType === "date" ? <CalendarDays aria-hidden="true" /> : "Auto"}
              <ChevronDown aria-hidden="true" className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuItem onSelect={() => onType("automatic")}>Automatic</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onType("date")}><CalendarDays aria-hidden="true" />Date</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onType("checkbox")}><SquareCheck aria-hidden="true" />Checkbox</DropdownMenuItem>
            {cellType === "checkbox" && <>
              <DropdownMenuItem onSelect={() => onCheckboxes(true)}>Check all</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onCheckboxes(false)}>Uncheck all</DropdownMenuItem>
            </>}
          </DropdownMenuContent>
        </DropdownMenu>
        {children}
      </div>
      <Dialog open={mode === "dropdown"} onOpenChange={(open) => setMode(open ? "dropdown" : null)}>
        <DialogTrigger asChild>
          <Button type="button" size="icon-xs" variant={list.length ? "secondary" : "ghost"} aria-label="Dropdown" title="Dropdown">
            <ListChecks aria-hidden="true" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dropdown options</DialogTitle>
            <DialogDescription>Choose the values allowed in {range}.</DialogDescription>
          </DialogHeader>
          <DropdownForm options={list} onSave={(options) => {
            onValidation(options ? { type: "list", options } : null);
            setMode(null);
          }} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function SheetFunctionMenu({ onCalculate }: { onCalculate: (operation: SheetCalculation) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Functions" title="Functions">
          <FunctionSquare aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {(Object.keys(calculations) as SheetCalculation[]).map((operation) =>
          <DropdownMenuItem key={operation} onSelect={() => onCalculate(operation)}>{calculations[operation]}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DropdownForm({ options, onSave }: { options: string[]; onSave: (values: string[] | null) => void }) {
  const [text, setText] = useState(options.join("\n"));
  const items = Array.from(new Set(text.split("\n").map((item) => item.trim()).filter(Boolean)));
  const ok = items.length > 0 && items.length <= MAX_VALIDATION_OPTIONS && items.every((item) => item.length <= 100);
  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (ok) onSave(items); }}>
      <label className="block space-y-1.5 text-sm">
        <span>One option per line</span>
        <textarea value={text} onChange={(event) => setText(event.target.value)} rows={5} maxLength={MAX_VALIDATION_OPTIONS * 101}
          className={controlClass + " resize-y"} />
      </label>
      <DialogFooter>
        {options.length > 0 && <Button type="button" variant="ghost" onClick={() => onSave(null)}>Remove dropdown</Button>}
        <Button type="submit" disabled={!ok}>Apply dropdown</Button>
      </DialogFooter>
    </form>
  );
}

function RulesForm({ range, rules, onRules }: { range: string; rules: SheetRule[]; onRules: (rules: SheetRule[]) => void }) {
  const [address, setAddress] = useState(range);
  const [operator, setOperator] = useState<RuleOperator>("greaterThan");
  const [amount, setAmount] = useState("");
  const [fill, setFill] = useState("#CCFBF1");
  const validRange = readRange(address);
  const canAdd = validRange && amount.trim() && Number.isFinite(Number(amount)) && rules.length < MAX_SHEET_RULES;

  function add(event: FormEvent) {
    event.preventDefault();
    if (!canAdd) return;
    onRules([...rules, { range: rangeLabel(validRange), operator, value: Number(amount), fill }]);
    setAmount("");
  }

  return (
    <div className="space-y-4">
      {rules.length > 0 && (
        <ul aria-label="Formatting rules" className="max-h-36 divide-y divide-border overflow-auto rounded-control border border-border">
          {rules.map((rule, index) => (
            <li key={index} className="flex items-center gap-2 px-2 py-1.5 text-sm">
              <span aria-hidden="true" className="size-3 shrink-0 rounded-sm border border-border" style={{ backgroundColor: rule.fill }} />
              <span className="min-w-0 flex-1 truncate">{rule.range} · {operations[rule.operator]} {rule.value}</span>
              <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove rule for ${rule.range}`}
                onClick={() => onRules(rules.filter((_, candidate) => index !== candidate))}><Trash2 aria-hidden="true" /></Button>
            </li>
          ))}
        </ul>
      )}
      <form className="grid grid-cols-2 gap-3" onSubmit={add}>
        <label className="space-y-1.5 text-sm"><span>Range</span><Input value={address} onChange={(event) => setAddress(event.target.value)} maxLength={20} /></label>
        <label className="space-y-1.5 text-sm">
          <span>Condition</span>
          <select className={controlClass} value={operator} onChange={(event) => setOperator(event.target.value as RuleOperator)}>
            {Object.entries(operations).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="space-y-1.5 text-sm"><span>Value</span>
          <Input type="number" step="any" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
        <label className="space-y-1.5 text-sm"><span>Fill color</span>
          <Input type="color" value={fill} onChange={(event) => setFill(event.target.value)} />
        </label>
        <DialogFooter className="col-span-2"><Button type="submit" disabled={!canAdd}>Add rule</Button></DialogFooter>
      </form>
    </div>
  );
}

function ChartForm({ range, onSave }: { range: string; onSave: (chart: SheetChart) => void }) {
  const [address, setAddress] = useState(range);
  const [kind, setKind] = useState<SheetChart["kind"]>("bar");
  const [title, setTitle] = useState("");
  const validRange = readRange(address);
  const ok = validRange && validRange.end.col > validRange.start.col && validRange.end.row > validRange.start.row && title.trim();
  return (
    <form className="grid grid-cols-2 gap-3" onSubmit={(event) => {
      event.preventDefault();
      if (ok) onSave({ range: rangeLabel(validRange), kind, title: title.trim() });
    }}>
      <label className="col-span-2 space-y-1.5 text-sm"><span>Chart title</span>
        <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} />
      </label>
      <label className="space-y-1.5 text-sm"><span>Range</span><Input value={address} onChange={(event) => setAddress(event.target.value)} maxLength={20} /></label>
      <label className="space-y-1.5 text-sm">
        <span>Chart type</span>
        <select className={controlClass} value={kind} onChange={(event) => setKind(event.target.value as SheetChart["kind"])}>
          {CHART_KINDS.map((type) => <option key={type} value={type}>{chartLabels[type]}</option>)}
        </select>
      </label>
      <DialogFooter className="col-span-2"><Button type="submit" disabled={!ok}>Create chart</Button></DialogFooter>
    </form>
  );
}
