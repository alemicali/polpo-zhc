import { useSyncExternalStore } from "react";

export type DataContextItem = {
  sourceId: string;
  dataset: string;
  queryId?: string;
  row?: Record<string, unknown>;
  viewId?: string;
  label: string;
};

export type DataPromptContext = { sessionId: string | null; items: DataContextItem[] };

let current: DataPromptContext | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
const snapshot = () => current;
const publish = (next: DataPromptContext | null) => { current = next; listeners.forEach((listener) => listener()); };

export function addDataPromptItem(sessionId: string | null, item: DataContextItem) {
  const items = current?.sessionId === sessionId ? current.items : [];
  const key = JSON.stringify([item.sourceId, item.dataset, item.row, item.viewId]);
  if (items.some((existing) => JSON.stringify([existing.sourceId, existing.dataset, existing.row, existing.viewId]) === key)) return;
  publish({ sessionId, items: [...items, item].slice(-12) });
}
export function removeDataPromptItem(index: number) {
  if (!current) return;
  const items = current.items.filter((_, itemIndex) => itemIndex !== index);
  publish(items.length ? { ...current, items } : null);
}
export function clearDataPromptContext() { publish(null); }
export function useDataPromptContext() { return useSyncExternalStore(subscribe, snapshot, snapshot); }
export function formatDataPromptContext(context: DataPromptContext): string {
  return ["Structured data references:", ...context.items.map((item, index) => [
    `[${index + 1}] ${item.label}`,
    `Source: ${item.sourceId}`,
    `Dataset: ${item.dataset}`,
    item.viewId ? `View: ${item.viewId}` : "",
    item.queryId ? `Query: ${item.queryId}` : "",
    item.row ? `Selected record: ${JSON.stringify(item.row)}` : "",
  ].filter(Boolean).join("\n"))].join("\n");
}
