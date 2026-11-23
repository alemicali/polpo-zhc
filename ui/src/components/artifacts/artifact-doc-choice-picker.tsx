import { useState } from "react";
import { Plus, SquareChevronDown, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  choiceColors, choiceTemplates, choiceTone, newChoiceDefinition, newChoiceOption, type DocChoiceColor, type DocChoiceDefinition,
} from "./artifact-doc-choices";

export function DocChoicePicker({ definitions, onInsert }: {
  definitions: DocChoiceDefinition[];
  onInsert: (definition: DocChoiceDefinition) => void;
}) {
  const [draft, setDraft] = useState<DocChoiceDefinition | null>(null);
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Dropdown" title="Dropdown"><SquareChevronDown /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="artifact-doc-surface">
        <DropdownMenuLabel>Document dropdowns</DropdownMenuLabel>
        {definitions.map((definition) => (
          <DropdownMenuItem key={definition.id} onSelect={() => onInsert(definition)}>
            <span className="flex-1">{definition.name}</span><span className="text-xs text-muted-foreground">{definition.options.length}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={() => setDraft(newChoiceDefinition())}><Plus /> New dropdown</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Templates</DropdownMenuLabel>
        {choiceTemplates.filter((template) => !definitions.some((definition) => definition.id === template.id)).map((template) => (
          <DropdownMenuItem key={template.id} onSelect={() => onInsert(template)}>
            <span className="flex-1">{template.name}</span><span className="text-xs text-muted-foreground">{template.options.length}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
    {draft && <DocChoiceDialog key={draft.id} initial={draft} onClose={() => setDraft(null)} onSave={onInsert} />}
  </>;
}

export function DocChoiceDialog({ initial, editing, onClose, onSave }: {
  initial: DocChoiceDefinition;
  editing?: boolean;
  onClose: () => void;
  onSave: (definition: DocChoiceDefinition) => void;
}) {
  const [draft, setDraft] = useState(initial);
  function updateOption(id: string, patch: Partial<{ label: string; color: DocChoiceColor }>) {
    setDraft((value) => ({
      ...value,
      options: value.options.map((option) => option.id === id ? { ...option, ...patch } : option),
    }));
  }

  const valid = !!draft.name.trim() && !!draft.options.length &&
    draft.options.every((option) => option.label.trim()) &&
    new Set(draft.options.map((option) => option.label.trim().toLowerCase())).size === draft.options.length;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="artifact-doc-surface">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit dropdown options" : "New dropdown"}</DialogTitle>
          <DialogDescription>Set the available choices for this inline field.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          onSave({
            ...draft,
            name: draft.name.trim(),
            options: draft.options.map((option) => ({ ...option, label: option.label.trim() })),
          });
          onClose();
        }}>
          <label className="grid gap-1 text-sm">
            <span>Dropdown name</span>
            <Input autoFocus required maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <div className="space-y-1.5">
            {draft.options.map((option, index) => (
              <div key={option.id} className="flex items-center gap-2">
                <select aria-label={`Color for option ${index + 1}`} title="Option color"
                  className={`h-8 max-w-24 rounded-control border px-1.5 text-xs ${choiceTone[option.color]}`}
                  value={option.color} onChange={(event) => {
                    const color = choiceColors.find((candidate) => candidate === event.target.value);
                    if (color) updateOption(option.id, { color });
                  }}>
                  {choiceColors.map((color) => <option key={color} value={color}>{color[0].toUpperCase() + color.slice(1)}</option>)}
                </select>
                <Input required maxLength={100} aria-label={`Option ${index + 1}`} value={option.label} onChange={(event) => updateOption(option.id, { label: event.target.value })} />
                <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove option ${index + 1}`} disabled={draft.options.length < 2}
                  onClick={() => setDraft({ ...draft, options: draft.options.filter((entry) => entry.id !== option.id) })}><Trash2 /></Button>
              </div>
            ))}
          </div>
          <Button type="button" size="sm" variant="outline" disabled={draft.options.length >= 30}
            onClick={() => setDraft({ ...draft, options: [...draft.options, newChoiceOption(choiceColors[draft.options.length % choiceColors.length])] })}><Plus /> Add option</Button>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!valid}>{editing ? "Save options" : "Create"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
