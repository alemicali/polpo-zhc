import { useSyncExternalStore } from "react";

export interface AppPreviewNode {
  tagName: string;
  selector: string;
  text: string;
  attributes: Record<string, string>;
  outerHTML: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface AppPreviewSelection {
  node: AppPreviewNode;
  screenshotDataUrl?: string;
}

export interface AppPreviewContext {
  sessionId: string | null;
  url: string;
  viewport: { width: number; height: number };
  deviceLabel: string;
  selections?: AppPreviewSelection[];
  screenshotDataUrl?: string;
}

let currentContext: AppPreviewContext | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentContext;
}

function publish(next: AppPreviewContext | null) {
  currentContext = next;
  listeners.forEach((listener) => listener());
}

export function setAppPreviewContext(context: AppPreviewContext) {
  publish(context);
}

export function clearAppPreviewContext() {
  publish(null);
}

export function useAppPreviewContext(): AppPreviewContext | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function formatAppPreviewContext(context: AppPreviewContext): string {
  const lines = [
    `App Preview URL: ${context.url}`,
    `Viewport: ${context.deviceLabel} (${context.viewport.width} x ${context.viewport.height})`,
  ];
  if (context.selections?.length) {
    lines.push(`Selected DOM elements: ${context.selections.length}`);
    context.selections.forEach(({ node, screenshotDataUrl }, index) => {
      lines.push(
        `[${index + 1}] Selector: ${node.selector}`,
        `[${index + 1}] Tag: ${node.tagName}`,
        `[${index + 1}] Text: ${node.text || "(empty)"}`,
        `[${index + 1}] Attributes: ${JSON.stringify(node.attributes)}`,
        `[${index + 1}] Bounds: ${JSON.stringify(node.rect)}`,
        `[${index + 1}] HTML: ${node.outerHTML}`,
      );
      if (screenshotDataUrl) lines.push(`[${index + 1}] A cropped screenshot of this element is attached as an image.`);
    });
  }
  if (context.screenshotDataUrl) lines.push("A screenshot of this viewport is attached as an image.");
  return lines.join("\n");
}
