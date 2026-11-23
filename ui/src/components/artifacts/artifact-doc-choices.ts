import { nanoid } from "nanoid";

export const choiceColors = ["slate", "blue", "green", "amber", "rose", "violet"] as const;
export type DocChoiceColor = typeof choiceColors[number];

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

export const choiceTone: Record<DocChoiceColor, string> = {
  slate: "border-border bg-muted text-muted-foreground",
  blue: "border-blue-300 bg-blue-100 text-blue-800 dark:border-blue-700 dark:bg-blue-900/40 dark:text-blue-200",
  green: "border-green-300 bg-green-100 text-green-800 dark:border-green-700 dark:bg-green-900/40 dark:text-green-200",
  amber: "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-200",
  rose: "border-rose-300 bg-rose-100 text-rose-800 dark:border-rose-700 dark:bg-rose-900/40 dark:text-rose-200",
  violet: "border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-700 dark:bg-violet-900/40 dark:text-violet-200",
};

export const choiceTemplates: DocChoiceDefinition[] = [
  {
    id: "status",
    name: "Status",
    options: [
      { id: "todo", label: "Not started", color: "slate" },
      { id: "doing", label: "In progress", color: "blue" },
      { id: "done", label: "Done", color: "green" },
    ],
  },
  {
    id: "priority",
    name: "Priority",
    options: [
      { id: "low", label: "Low", color: "blue" },
      { id: "medium", label: "Medium", color: "amber" },
      { id: "high", label: "High", color: "rose" },
    ],
  },
];

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
