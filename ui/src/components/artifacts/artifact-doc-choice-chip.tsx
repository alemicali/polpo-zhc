import { createContext, useContext, useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Check, ChevronDown, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  choiceTone, decodeDocChoice, encodeDocChoice, newChoiceOption, selectedChoice, type DocChoiceDefinition,
} from "./artifact-doc-choices";
import { DocChoiceDialog } from "./artifact-doc-choice-picker";

const chipClass = "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 align-baseline text-xs font-medium leading-tight";

export const DocChoiceEditContext = createContext<((definition: DocChoiceDefinition) => void) | null>(null);

export function DocChoiceChip({ node, updateAttributes }: NodeViewProps) {
  const choice = decodeDocChoice(node.attrs.choice);
  const updateDefinition = useContext(DocChoiceEditContext);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<DocChoiceDefinition | null>(null);

  if (!choice) return <NodeViewWrapper as="span" contentEditable={false}>Dropdown</NodeViewWrapper>;
  const option = selectedChoice(choice);
  const search = query.trim();
  const folded = search.toLowerCase();
  const matches = choice.options.filter((entry) => entry.label.toLowerCase().includes(folded));
  const canAdd = !!search && choice.options.length < 30 && !choice.options.some((entry) => entry.label.toLowerCase() === folded);

  function editOptions(definition: DocChoiceDefinition) {
    setOpen(false);
    setDraft(definition);
  }

  function select(value?: string) {
    if (!choice) return;
    updateAttributes({ choice: encodeDocChoice({ ...choice, selected: value }) });
    setOpen(false);
  }

  return (
    <NodeViewWrapper as="span" className="mx-0.5 inline-block" contentEditable={false}>
      <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) setQuery(""); }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`${chipClass} ${choiceTone[option?.color ?? "slate"]} outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring`}
            aria-label={`${choice.name}, ${option?.label ?? "not set"}`}
          >
            {option?.label ?? choice.name}
            <ChevronDown className="size-3" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-60 p-0">
          <Command shouldFilter={false}>
            <CommandInput aria-label="Find or add an option" placeholder="Find or add an option…" value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandGroup heading={choice.name}>
                {!search && <CommandItem value="not-set" onSelect={() => select()}>Not set</CommandItem>}
                {matches.map((entry) => (
                  <CommandItem value={`entry-${entry.id}`} key={entry.id} onSelect={() => select(entry.id)}>
                    <span className={`${chipClass} ${choiceTone[entry.color]}`}>{entry.label}</span>
                    {entry.id === choice.selected && <Check className="ml-auto" />}
                  </CommandItem>
                ))}
                {canAdd && (
                  <CommandItem value="new-option" onSelect={() => editOptions({
                    ...choice,
                    options: [...choice.options, { ...newChoiceOption(), label: search.slice(0, 100) }],
                  })}><Plus /> Add “{search.slice(0, 100)}”</CommandItem>
                )}
              </CommandGroup>
            </CommandList>
          </Command>
          <div className="border-t p-1">
            <Button type="button" size="sm" variant="ghost" className="w-full justify-start" onClick={() => editOptions(choice)}><Pencil /> Edit options</Button>
          </div>
        </PopoverContent>
      </Popover>
      {draft && <DocChoiceDialog initial={draft} editing onClose={() => setDraft(null)} onSave={(definition) => {
        if (updateDefinition) updateDefinition(definition);
        else updateAttributes({ choice: encodeDocChoice({ ...definition, selected: choice.selected }) });
      }} />}
    </NodeViewWrapper>
  );
}
