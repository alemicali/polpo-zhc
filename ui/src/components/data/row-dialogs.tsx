/**
 * Row dialogs, from Lumea's database panel: insert and edit a row (a field per column, primary key
 * and required marks, the type as a hint), and the delete confirmation. Added for Polpo: a row
 * detail sheet, NULL as an explicit choice, typed values (numbers, booleans, JSON), and one
 * confirmation for every change that says what it changes and how many rows it will touch
 * (counted on the source before anything is written).
 */
import { useMemo, useState } from "react";
import { AlertTriangle, Check, KeyRound, Loader2, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { DataColumn, DataFilter } from "@/hooks/use-data";
import { cn } from "@/lib/utils";
import { coerceValue, describeFilters, editableValue, errorMessage, formatCell } from "./data-utils";

// ── Row form (insert / edit) ───────────────────────────────────────────

export interface RowFormDialogProps {
  open: boolean;
  mode: "insert" | "edit";
  dataset: string;
  columns: DataColumn[];
  /** The row being edited. */
  row?: Record<string, unknown>;
  onClose: () => void;
  /** The values to write (edit: only the changed fields). The parent confirms and saves. */
  onSubmit: (values: Record<string, unknown>) => void;
}

export function RowFormDialog({ open, mode, dataset, columns, row, onClose, onSubmit }: RowFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        {/* remounted per row so the fields start from its values */}
        {open && <RowForm key={`${mode}:${JSON.stringify(row ?? {})}`} mode={mode} dataset={dataset} columns={columns} row={row} onClose={onClose} onSubmit={onSubmit} />}
      </DialogContent>
    </Dialog>
  );
}

function RowForm({ mode, dataset, columns, row, onClose, onSubmit }: Omit<RowFormDialogProps, "open">) {
  const initial = useMemo(() => Object.fromEntries(columns.map((column) => [column.name, mode === "edit" ? editableValue(row?.[column.name]) : ""])), [columns, mode, row]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  // insert: a nullable column or one with a default starts unset (NULL / default); edit: as stored
  const [nulls, setNulls] = useState<Set<string>>(() => new Set(columns.filter((column) => mode === "edit" ? row?.[column.name] === null : false).map((column) => column.name)));
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    try {
      const out: Record<string, unknown> = {};
      for (const column of columns) {
        const raw = values[column.name] ?? "";
        const isNull = nulls.has(column.name);
        if (mode === "insert") {
          if (!isNull && raw === "") continue; // left empty: the database default
          out[column.name] = coerceValue(raw, column, isNull);
        } else {
          if (column.primaryKey) continue;
          const wasNull = row?.[column.name] === null || row?.[column.name] === undefined;
          if (raw === initial[column.name] && isNull === wasNull) continue;
          out[column.name] = coerceValue(raw, column, isNull);
        }
      }
      if (Object.keys(out).length === 0) { setError(mode === "edit" ? "Nothing changed." : "Fill in at least one field."); return; }
      onSubmit(out);
    } catch (reason) { setError(errorMessage(reason)); }
  };

  return (
    <>
      <DialogHeader className="shrink-0 border-b px-6 pb-4 pt-6 pr-12">
        <DialogTitle>{mode === "insert" ? "Insert row" : "Edit row"}</DialogTitle>
        <DialogDescription>
          {mode === "insert" ? <>Add a row to <span className="font-mono">{dataset}</span>. Empty fields take the column's default.</> : <>Change this row of <span className="font-mono">{dataset}</span>. Only changed fields are written.</>}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <form className="space-y-4" noValidate onSubmit={(event) => { event.preventDefault(); submit(); }}>
          {columns.map((column) => (
            <RowField
              key={column.name}
              column={column}
              value={values[column.name] ?? ""}
              isNull={nulls.has(column.name)}
              readOnly={mode === "edit" && !!column.primaryKey}
              required={mode === "insert" && column.nullable === false && column.defaultValue == null && !column.primaryKey}
              onChange={(value) => { setError(null); setValues((current) => ({ ...current, [column.name]: value })); }}
              onNull={(value) => { setError(null); setNulls((current) => { const next = new Set(current); if (value) next.add(column.name); else next.delete(column.name); return next; }); }}
            />
          ))}
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <DialogFooter sticky>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit"><Check /> {mode === "insert" ? "Review insert" : "Review changes"}</Button>
          </DialogFooter>
        </form>
      </DialogBody>
    </>
  );
}

function RowField({ column, value, isNull, readOnly, required, onChange, onNull }: {
  column: DataColumn; value: string; isNull: boolean; readOnly: boolean; required: boolean;
  onChange: (value: string) => void; onNull: (value: boolean) => void;
}) {
  const id = `row-field-${column.name}`;
  const placeholder = column.defaultValue ? `Default: ${column.defaultValue}` : column.nativeType ?? column.type;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
          {column.primaryKey && <KeyRound className="size-3 text-warning" aria-label="Primary key" />}
          <span className="truncate font-mono">{column.name}</span>
          {required && <span className="text-destructive" aria-label="required">*</span>}
        </label>
        <span className="truncate font-mono text-micro text-muted-foreground">{column.nativeType ?? column.type}</span>
        <span className="flex-1" />
        {column.nullable && !readOnly && (
          <label className="flex items-center gap-1.5 text-micro text-muted-foreground">
            <Checkbox checked={isNull} onCheckedChange={(checked) => onNull(checked === true)} aria-label={`${column.name} is NULL`} /> NULL
          </label>
        )}
      </div>
      {column.type === "boolean" ? (
        <Select value={isNull ? "" : value} onValueChange={onChange} disabled={readOnly || isNull}>
          <SelectTrigger id={id} className="w-full" aria-label={column.name}><SelectValue placeholder={isNull ? "NULL" : placeholder} /></SelectTrigger>
          <SelectContent><SelectItem value="true">true</SelectItem><SelectItem value="false">false</SelectItem></SelectContent>
        </Select>
      ) : column.type === "json" ? (
        <Textarea id={id} value={isNull ? "" : value} onChange={(event) => onChange(event.target.value)} disabled={readOnly || isNull} placeholder={isNull ? "NULL" : placeholder} className="min-h-20 font-mono text-xs" />
      ) : (
        <Input
          id={id}
          value={isNull ? "" : value}
          onChange={(event) => onChange(event.target.value)}
          disabled={readOnly || isNull}
          placeholder={isNull ? "NULL" : placeholder}
          inputMode={column.type === "number" ? "decimal" : undefined}
          className={cn(column.primaryKey || column.type === "number" ? "font-mono" : "")}
        />
      )}
    </div>
  );
}

// ── Row detail sheet ───────────────────────────────────────────────────

export function RowSheet({ open, dataset, columns, row, canEdit, onClose, onEdit, onDelete }: {
  open: boolean; dataset: string; columns: DataColumn[]; row?: Record<string, unknown>; canEdit: boolean;
  onClose: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const keys = columns.filter((column) => column.primaryKey);
  const title = keys.length && row ? keys.map((column) => `${column.name} ${formatCell(row[column.name])}`).join(", ") : "Row";
  return (
    <Sheet open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="truncate font-mono text-sm">{title}</SheetTitle>
          <SheetDescription>A row of <span className="font-mono">{dataset}</span></SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {row && (
            <dl className="divide-y divide-border">
              {columns.map((column) => {
                const value = row[column.name];
                return (
                  <div key={column.name} className="grid gap-1 py-2.5">
                    <dt className="flex items-center gap-1.5 text-micro text-muted-foreground">
                      {column.primaryKey && <KeyRound className="size-3 text-warning" aria-label="Primary key" />}
                      <span className="font-mono">{column.name}</span><span className="font-mono opacity-70">{column.nativeType ?? column.type}</span>
                    </dt>
                    <dd className={cn("min-w-0 whitespace-pre-wrap break-words text-sm", value === null || value === undefined ? "italic text-muted-foreground" : typeof value === "object" ? "font-mono text-xs" : "")}>
                      {value !== null && typeof value === "object" ? JSON.stringify(value, null, 2) : formatCell(value)}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
        </div>
        {canEdit && (
          <div className="flex shrink-0 justify-end gap-2 border-t p-4">
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={onDelete}><Trash2 /> Delete</Button>
            <Button onClick={onEdit}><Pencil /> Edit</Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── Confirm a change ───────────────────────────────────────────────────

export interface PendingMutation {
  operation: "insert" | "update" | "delete";
  dataset: string;
  values?: Record<string, unknown>;
  /** One entry per row the change targets (update / delete); each is that row's filters. */
  targets?: DataFilter[][];
  /** The rows are matched by every value (the table has no primary key). */
  byAllColumns?: boolean;
}

export function ConfirmMutationDialog({ pending, sourceName, affected, running, onCancel, onConfirm }: {
  pending: PendingMutation | null;
  sourceName: string;
  /** Rows the change will touch (counted before writing): undefined while counting, null when it could not be counted. */
  affected?: number | null;
  running: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const op = pending?.operation;
  const count = pending?.targets?.length ?? 1;
  const title = !pending ? "" : op === "insert" ? `Insert a row into ${pending.dataset}?` : op === "update" ? `Update ${count === 1 ? "this row" : `${count} rows`}?` : `Delete ${count === 1 ? "this row" : `${count} rows`}?`;
  const tooMany = typeof affected === "number" && op !== "insert" && affected > count;
  return (
    <Dialog open={!!pending} onOpenChange={(value) => { if (!value && !running) onCancel(); }}>
      <DialogContent className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 border-b px-6 pb-4 pt-6 pr-12">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {op === "delete" ? "This cannot be undone. " : ""}It runs on <span className="font-medium text-foreground">{sourceName}</span> / <span className="font-mono">{pending?.dataset}</span> and is recorded in the source's activity.
          </DialogDescription>
        </DialogHeader>
        {pending && (
          <DialogBody>
            <div className="space-y-4 text-xs">
              {pending.values && Object.keys(pending.values).length > 0 && (
                <section>
                  <h4 className="mb-1.5 font-medium text-muted-foreground">{op === "insert" ? "Values" : "Set"}</h4>
                  <dl className="divide-y divide-border rounded-card border border-border">
                    {Object.entries(pending.values).map(([field, value]) => (
                      <div key={field} className="grid grid-cols-[minmax(6rem,0.4fr)_1fr] gap-3 px-3 py-1.5">
                        <dt className="truncate font-mono">{field}</dt>
                        <dd className={cn("min-w-0 break-words font-mono", value === null && "italic text-muted-foreground")}>{formatCell(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}
              {pending.targets && pending.targets.length > 0 && (
                <section>
                  <h4 className="mb-1.5 font-medium text-muted-foreground">Where</h4>
                  <ul className="max-h-40 space-y-1 overflow-auto rounded-card border border-border p-2 font-mono">
                    {pending.targets.slice(0, 50).map((filters, index) => <li key={index} className="break-words">{describeFilters(filters)}</li>)}
                    {pending.targets.length > 50 && <li className="text-muted-foreground">…and {pending.targets.length - 50} more</li>}
                  </ul>
                </section>
              )}
              {op !== "insert" && (
                <p className={cn("flex items-start gap-2 rounded-card border p-2.5", tooMany ? "border-warning/40 bg-warning/10 text-warning" : "border-border bg-muted/40 text-muted-foreground")} aria-live="polite">
                  {affected === undefined ? <><Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" /> Counting the rows it will change…</> : affected === null ? <><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> The rows it will change could not be counted.</> : (
                    <>
                      {tooMany && <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />}
                      <span>
                        {affected} row{affected === 1 ? "" : "s"} will {op === "delete" ? "be deleted" : "change"}.
                        {tooMany && (pending.byAllColumns ? " The table has no primary key: every row with exactly these values matches." : " More rows match than you selected.")}
                      </span>
                    </>
                  )}
                </p>
              )}
            </div>
            <DialogFooter sticky>
              <Button variant="outline" onClick={onCancel} disabled={running}>Cancel</Button>
              <Button variant={op === "delete" ? "destructive" : "default"} onClick={onConfirm} disabled={running || (op !== "insert" && affected === 0)}>
                {running ? <Loader2 className="animate-spin" /> : op === "delete" ? <Trash2 /> : <Check />}
                {op === "insert" ? "Insert" : op === "update" ? "Update" : "Delete"}
              </Button>
            </DialogFooter>
          </DialogBody>
        )}
      </DialogContent>
    </Dialog>
  );
}
