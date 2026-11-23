import { nanoid } from "nanoid";

import { DOC_CHOICE_COLORS, DOC_CHOICE_TEMPLATES, type DocChoiceColor } from "./artifact-content-palette";

export const choiceColors = DOC_CHOICE_COLORS;
export type { DocChoiceColor };

export interface DocChoiceOption {
  id: string;
  label: string;
  color: DocChoiceColor;
}

export interface DocChoiceDefinition {
  id: string;
  name: string;
  options: DocChoiceOption[];
}

export interface DocChoice extends DocChoiceDefinition {
  selected?: string;
}

/** How a choice colour looks in the dashboard: the theme's agent hues (a doc's chips follow the look). */
export const choiceTone: Record<DocChoiceColor, string> = {
  slate: "border-border bg-muted text-muted-foreground",
  blue: "border-agent-1/40 bg-agent-1/15 text-foreground",
  green: "border-agent-3/40 bg-agent-3/15 text-foreground",
  amber: "border-agent-5/40 bg-agent-5/15 text-foreground",
  rose: "border-agent-2/40 bg-agent-2/15 text-foreground",
  violet: "border-agent-7/40 bg-agent-7/15 text-foreground",
};

export const choiceTemplates: DocChoiceDefinition[] = DOC_CHOICE_TEMPLATES;

export function newChoiceOption(color: DocChoiceColor = "slate"): DocChoiceOption {
  return { id: nanoid(10), label: "", color };
}

export function newChoiceDefinition(): DocChoiceDefinition {
  return { id: nanoid(12), name: "", options: [newChoiceOption()] };
}

export const selectedChoice = (choice: DocChoice) => choice.options.find((option) => option.id === choice.selected);

export function encodeDocChoice(choice: DocChoice): string {
  return encodeURIComponent(JSON.stringify(choice));
}

export function decodeDocChoice(value: unknown): DocChoice | undefined {
  if (typeof value !== "string" || value.length > 40_000) return undefined;
  try {
    const raw: Partial<DocChoice> = JSON.parse(decodeURIComponent(value));
    if (typeof raw.id !== "string" || !/^[\w-]{1,20}$/.test(raw.id)) return undefined;
    if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 100) return undefined;
    if (!Array.isArray(raw.options) || !raw.options.length || raw.options.length > 30) return undefined;
    const ids = new Set<string>();
    const options: DocChoiceOption[] = [];
    for (const option of raw.options) {
      if (!option || typeof option.id !== "string" || !/^[\w-]{1,20}$/.test(option.id) || ids.has(option.id)) return undefined;
      if (typeof option.label !== "string" || !option.label.trim() || option.label.length > 100) return undefined;
      if (!choiceColors.includes(option.color)) return undefined;
      ids.add(option.id);
      options.push({ id: option.id, label: option.label, color: option.color });
    }
    return { id: raw.id, name: raw.name, options, ...(raw.selected && ids.has(raw.selected) ? { selected: raw.selected } : {}) };
  } catch {
    return undefined;
  }
}

const choiceMarker = /<span data-polpo-doc-choice="([^"\r\n]+)">[^<]*<\/span>/g;

export function choiceToMarkdown(choice: DocChoice): string {
  const label = (selectedChoice(choice)?.label ?? choice.name).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<span data-polpo-doc-choice="${encodeDocChoice(choice)}">${label}</span>`;
}

export function updateChoiceDefinition(content: string, definition: DocChoiceDefinition): string {
  return content.replace(choiceMarker, (marker: string, value: string) => {
    const choice = decodeDocChoice(value);
    if (!choice || choice.id !== definition.id) return marker;
    const selected = definition.options.some((option) => option.id === choice.selected) ? choice.selected : undefined;
    return choiceToMarkdown({ ...definition, selected });
  });
}

export function readChoiceDefinitions(content: string): DocChoiceDefinition[] {
  const definitions = new Map<string, DocChoiceDefinition>();
  for (const match of content.matchAll(choiceMarker)) {
    const choice = decodeDocChoice(match[1]);
    if (choice) definitions.set(choice.id, { id: choice.id, name: choice.name, options: choice.options });
  }
  return [...definitions.values()];
}
