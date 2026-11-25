/**
 * Inputs shared by the install dialog of a ready-made connector and a hosted server's Settings tab:
 * a typed setting (text, number, choice, on / off) and a write-only secret (the value goes to the
 * vault and is never shown or read back; only "saved" / "not set" is).
 */
import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, KeyRound, Loader2 } from "lucide-react";
import type { McpServerSettingField, McpServerTemplateSecret } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "./connector-bits";

const selectClass = "h-9 w-full rounded-md border bg-transparent px-2 text-sm";

export type SettingValue = string | number | boolean | undefined;

/** One setting, by its type. Text and numbers are kept as typed (the server validates them). */
export function SettingInput({ field, value, onChange, disabled }: {
  field: McpServerSettingField; value: SettingValue; onChange: (v: SettingValue) => void; disabled?: boolean;
}) {
  const id = `setting-${field.key}`;
  const placeholder = field.default !== undefined ? `Default: ${String(field.default)}` : field.required ? "Required" : "Optional";
  return (
    <div className="space-y-1 text-sm" data-testid={id}>
      {field.type === "boolean" ? (
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium">{field.label}</span>
          <Switch label={field.label} checked={value === undefined ? field.default === true : value === true} disabled={disabled} onChange={(v) => onChange(v)} />
        </div>
      ) : (
        <>
          <label htmlFor={id} className="font-medium">{field.label}{field.required && <span className="text-destructive"> *</span>}</label>
          {field.type === "enum" ? (
            <select id={id} className={selectClass} value={value === undefined ? "" : String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value || undefined)}>
              <option value="">{placeholder}</option>
              {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <Input id={id} value={value === undefined ? "" : String(value)} placeholder={placeholder} disabled={disabled}
              inputMode={field.type === "number" ? "decimal" : undefined}
              onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />
          )}
        </>
      )}
      {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
    </div>
  );
}


/** The vendor's instructions for a secret: where to create it, scopes, advice. */
export function SecretHelp({ info }: { info: McpServerTemplateSecret }) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>
        {info.howTo}
        {info.url && <> <a href={info.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary underline-offset-2 hover:underline">Open <ExternalLink className="h-3 w-3" /></a></>}
      </p>
      {info.scopes?.length ? <p>Scopes: {info.scopes.join(", ")}</p> : null}
      {info.recommendation && <p>{info.recommendation}</p>}
    </div>
  );
}

/**
 * A write-only secret: type or paste, then save — the value goes to the vault and the field empties.
 * `onSave` absent: the value is only handed to `onChange` (the install dialog sends it with the install).
 */
export function SecretInput({ name, label, isSet, onSave, onChange, value: controlled, focus, disabled }: {
  name: string; label: string; isSet?: boolean; focus?: boolean; disabled?: boolean;
  onSave?: (value: string) => Promise<void>;
  onChange?: (value: string) => void;
  /** Controlled by the parent (which empties it once the value is sent). */
  value?: string;
}) {
  const [inner, setInner] = useState("");
  const value = controlled ?? inner;
  const setValue = (v: string) => { setInner(v); };
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focus) ref.current?.focus(); }, [focus]);
  const save = async () => {
    if (!onSave || !value.trim()) return;
    setSaving(true);
    try { await onSave(value); setValue(""); } finally { setSaving(false); }
  };
  return (
    <div className="space-y-1 text-sm" data-testid={`secret-input-${name}`}>
      <div className="flex items-center gap-2">
        <label htmlFor={`secret-${name}`} className="flex items-center gap-1.5 font-medium"><KeyRound className="h-3.5 w-3.5 text-muted-foreground" /> {label}</label>
        {isSet !== undefined && (isSet
          ? <Badge variant="secondary" className="gap-1 text-micro font-normal"><Check className="h-3 w-3" /> saved in the vault</Badge>
          : <Badge variant="outline" className="text-micro font-normal text-warning">not set</Badge>)}
      </div>
      <div className="flex gap-2">
        <Input
          id={`secret-${name}`} ref={ref} type="password" autoComplete="off" spellCheck={false} value={value} disabled={disabled || saving}
          placeholder={isSet ? "Saved — paste a new value to replace it" : "Paste the value"}
          onChange={(e) => { setValue(e.target.value); onChange?.(e.target.value); }}
          onKeyDown={(e) => { if (e.key === "Enter" && onSave) { e.preventDefault(); void save(); } }}
        />
        {onSave && (
          <Button size="sm" className="h-9 shrink-0" disabled={disabled || saving || !value.trim()} onClick={() => void save()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Save to vault
          </Button>
        )}
      </div>
    </div>
  );
}
