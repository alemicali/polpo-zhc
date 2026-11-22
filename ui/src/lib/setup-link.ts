/**
 * Links from an assistant (MCP setup_url): /config?section=channels&channel=ops&focus=botToken&setup=channel:ops:botToken.
 * The page opens the section, selects the item (the channel's form, the provider's key dialog…),
 * scrolls to the field and focuses it; after the save, a toast says to go back to the assistant
 * (which is waiting with polpo_setup_wait).
 */
import { toast } from "sonner";

export interface SetupParams {
  section?: string;
  channel?: string;
  provider?: string;
  connector?: string;
  service?: string;
  /** The field to focus (data-setup-field). */
  focus?: string;
  /** What the assistant waits for (the setup_id). */
  setup?: string;
}

/** The page's query: the URL's, or (Electron's HashRouter) the one inside the hash. */
function currentQuery(): string {
  if (typeof window === "undefined") return "";
  if (window.location.search) return window.location.search;
  const hash = window.location.hash;
  return hash.includes("?") ? hash.slice(hash.indexOf("?")) : "";
}

export function readSetupParams(search: string = currentQuery()): SetupParams {
  const p = new URLSearchParams(search);
  const out: SetupParams = {};
  for (const key of ["section", "channel", "provider", "connector", "service", "focus", "setup"] as const) {
    const v = p.get(key);
    if (v) out[key] = v;
  }
  return out;
}

/** A value inside a quoted attribute selector (CSS.escape is missing in some environments). */
const quote = (v: string) => v.replace(/["\\]/g, "\\$&");

/** The element to focus: [data-setup-field=focus], within the item's [data-setup-item] when there is one. */
export function findSetupField(root: ParentNode, params: SetupParams): HTMLElement | null {
  if (!params.focus) return null;
  const field = `[data-setup-field="${quote(params.focus)}"]`;
  const item = params.provider ?? params.channel ?? params.connector;
  return (item ? root.querySelector<HTMLElement>(`[data-setup-item="${quote(item)}"] ${field}, ${field}[data-setup-item="${quote(item)}"]`) : null)
    ?? root.querySelector<HTMLElement>(field);
}

/**
 * Scroll to the field and focus it once it is on the page (forms and dialogs open a moment later).
 * Returns a cleanup that stops looking.
 */
export function focusSetupField(params: SetupParams, root: ParentNode = document, timeoutMs = 5000): () => void {
  if (!params.focus) return () => {};
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const look = () => {
    const el = findSetupField(root, params);
    if (el) {
      el.scrollIntoView?.({ block: "center", behavior: "smooth" });
      el.focus({ preventScroll: true });
      return;
    }
    if (Date.now() - started < timeoutMs) timer = setTimeout(look, 100);
  };
  look();
  return () => { if (timer) clearTimeout(timer); };
}

/**
 * After a save: when the page was opened from an assistant's link, say so and drop the setup
 * parameters (a second save does not repeat it). Returns whether it did.
 */
export function notifySetupSaved(): boolean {
  if (typeof window === "undefined") return false;
  const url = new URL(window.location.href);
  if (!url.searchParams.get("setup")) return false;
  toast.success("Done — go back to your assistant", { description: "It sees the change and continues from there.", duration: 8000 });
  for (const key of ["setup", "focus"]) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return true;
}
