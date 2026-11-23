/**
 * The table toolbar's popovers, from Lumea's database panel: the filter builder (column, operator,
 * value; several filters all must match) and the column picker. On Polpo's operators and tokens.
 */
import { useState } from "react";
import { Columns2, Filter, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { DataColumn } from "@/hooks/use-data";
import { cn } from "@/lib/utils";
import { FILTER_OPERATORS, type FilterDraft, type FilterOperator } from "./data-utils";

export function FilterPopover({ columns, filters, onChange }: { columns: DataColumn[]; filters: FilterDraft[]; onChange: (next: FilterDraft[]) => void }) {
  const [open, setOpen] = useState(false);
  const active = filters.filter((filter) => filter.operator === "isNull" || filter.value.trim() !== "").length;
  const update = (index: number, patch: Partial<FilterDraft>) => onChange(filters.map((filter, i) => (i === index ? { ...filter, ...patch } : filter)));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn(active > 0 && "border-primary text-primary")} aria-label={active ? `Filters (${active} active)` : "Filter"}>
          <Filter /> Filter
          {active > 0 && <span className="rounded-pill bg-primary px-1.5 text-micro text-primary-foreground">{active}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(26rem,calc(100vw-2rem))] p-3">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Filters</p>
            {filters.length > 0 && <Button variant="ghost" size="xs" onClick={() => onChange([])}>Clear all</Button>}
          </div>
          {filters.length === 0 && <p className="text-xs text-muted-foreground">No filters: every row is shown. All filters must match.</p>}
          {filters.map((filter, index) => {
            const operator = FILTER_OPERATORS.find((item) => item.value === filter.operator);
            return (
              <div key={index} className="flex flex-wrap items-center gap-2 sm:flex-nowrap" role="group" aria-label={`Filter ${index + 1}`}>
                <Select value={filter.field} onValueChange={(value) => update(index, { field: value })}>
                  <SelectTrigger size="sm" className="h-8 w-[calc(50%-0.25rem)] text-xs sm:w-32" aria-label="Column"><SelectValue placeholder="Column" /></SelectTrigger>
                  <SelectContent>{columns.map((column) => <SelectItem key={column.name} value={column.name} className="text-xs">{column.name}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={filter.operator} onValueChange={(value) => update(index, { operator: value as FilterOperator })}>
                  <SelectTrigger size="sm" className="h-8 w-[calc(50%-0.25rem)] text-xs sm:w-36" aria-label="Operator"><SelectValue /></SelectTrigger>
                  <SelectContent>{FILTER_OPERATORS.map((item) => <SelectItem key={item.value} value={item.value} className="text-xs">{item.label}</SelectItem>)}</SelectContent>
                </Select>
                {operator?.needsValue && (
                  <Input value={filter.value} onChange={(event) => update(index, { value: event.target.value })} placeholder="Value" aria-label="Value" className="h-8 min-w-0 flex-1 text-xs" />
                )}
                <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={`Remove filter ${index + 1}`} onClick={() => onChange(filters.filter((_, i) => i !== index))}><X /></Button>
              </div>
            );
          })}
          {columns.length > 0 && (
            <Button variant="outline" size="sm" className="w-full" onClick={() => onChange([...filters, { field: columns[0]!.name, operator: "eq", value: "" }])}>
              <Plus /> Add filter
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ColumnsPopover({ columns, hidden, onChange }: { columns: DataColumn[]; hidden: Set<string>; onChange: (next: Set<string>) => void }) {
  const toggle = (name: string) => {
    const next = new Set(hidden);
    if (next.has(name)) next.delete(name); else next.add(name);
    onChange(next);
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label={hidden.size ? `Columns (${hidden.size} hidden)` : "Columns"}>
          <Columns2 /> <span className="hidden sm:inline">Columns</span>
          {hidden.size > 0 && <span className="text-micro text-muted-foreground">{columns.length - hidden.size}/{columns.length}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-2">
        <div className="flex items-center justify-between px-2 py-1">
          <p className="text-xs font-medium text-muted-foreground">Toggle columns</p>
          {hidden.size > 0 && <Button variant="ghost" size="xs" onClick={() => onChange(new Set())}>Show all</Button>}
        </div>
        <div className="max-h-72 overflow-auto">
          {columns.map((column) => (
            <label key={column.name} className="flex w-full cursor-pointer items-center gap-2 rounded-xs px-2 py-1.5 text-sm hover:bg-muted">
              <Checkbox checked={!hidden.has(column.name)} onCheckedChange={() => toggle(column.name)} aria-label={`Show ${column.name}`} />
              <span className="truncate">{column.name}</span>
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
