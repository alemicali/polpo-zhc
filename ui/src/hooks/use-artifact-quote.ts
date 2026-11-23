import { useSyncExternalStore } from "react";

type ArtifactQuote = { artifactId: string; sessionId: string | null; text: string };
let current: ArtifactQuote | null = null;
const changes = new EventTarget();
const snapshot = () => current;
function subscribe(notify: () => void) {
  changes.addEventListener("change", notify);
  return () => changes.removeEventListener("change", notify);
}

export function askAboutArtifact(artifactId: string, sessionId: string | null, text = "") {
  current = { artifactId, sessionId, text: text.trim() };
  changes.dispatchEvent(new Event("change"));
}

export function clearArtifactQuote(quote: ArtifactQuote) {
  if (current !== quote) return;
  current = null;
  changes.dispatchEvent(new Event("change"));
}

export function useArtifactQuote(artifactId: string | undefined, sessionId: string | null) {
  const selection = useSyncExternalStore(subscribe, snapshot, snapshot);
  return selection?.artifactId === artifactId && selection?.sessionId === sessionId ? selection : null;
}
