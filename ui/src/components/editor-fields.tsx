// Form fields shared by the graph editors: edits are buffered locally and
// committed on blur (or Enter), so a rename does not fire on every keystroke.

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/** Local edit buffer that resets when the committed value changes (e.g. another node is selected). */
function useCommitBuffer(value: string) {
  const [local, setLocal] = useState(value);
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setLocal(value);
  }
  return [local, setLocal] as const;
}

/** Text input that commits on blur or Enter, so renames do not fire on every keystroke. */
export function CommitInput({ value, onCommit, ...props }: { value: string; onCommit: (v: string) => void } & Omit<React.ComponentProps<typeof Input>, "value" | "onChange">) {
  const [local, setLocal] = useCommitBuffer(value);
  return (
    <Input
      {...props}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => { if (local !== value) onCommit(local); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

export function CommitTextarea({ value, onCommit, ...props }: { value: string; onCommit: (v: string) => void } & Omit<React.ComponentProps<typeof Textarea>, "value" | "onChange">) {
  const [local, setLocal] = useCommitBuffer(value);
  return (
    <Textarea
      {...props}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => { if (local !== value) onCommit(local); }}
    />
  );
}
