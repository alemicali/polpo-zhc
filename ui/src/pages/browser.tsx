import { useState } from "react";
import type { FormEvent } from "react";
import {
 ArrowLeft,
 ArrowRight,
 ExternalLink,
 Loader2,
 Lock,
 RefreshCw,
 Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const DEFAULT_URL = "https://www.google.com/search?igu=1";

function normalizeBrowserUrl(value: string): string {
 const trimmed = value.trim();
 if (!trimmed) return DEFAULT_URL;

 if (/^https?:\/\//i.test(trimmed)) return trimmed;
 if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed)) return `https://${trimmed}`;

 return `https://www.google.com/search?igu=1&q=${encodeURIComponent(trimmed)}`;
}

export function BrowserPage() {
 const [history, setHistory] = useState<string[]>([DEFAULT_URL]);
 const [index, setIndex] = useState(0);
 const [draft, setDraft] = useState(DEFAULT_URL);
 const [isLoading, setIsLoading] = useState(true);
 const [reloadKey, setReloadKey] = useState(0);

 const currentUrl = history[index] ?? DEFAULT_URL;
 const canGoBack = index > 0;
 const canGoForward = index < history.length - 1;

 const navigateTo = (rawValue: string) => {
 const nextUrl = normalizeBrowserUrl(rawValue);
 setHistory((items) => [...items.slice(0, index + 1), nextUrl]);
 setIndex((value) => value + 1);
 setDraft(nextUrl);
 setIsLoading(true);
 };

 const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
 event.preventDefault();
 navigateTo(draft);
 };

 const goBack = () => {
 if (!canGoBack) return;
 const nextIndex = index - 1;
 setIndex(nextIndex);
 setDraft(history[nextIndex] ?? DEFAULT_URL);
 setIsLoading(true);
 };

 const goForward = () => {
 if (!canGoForward) return;
 const nextIndex = index + 1;
 setIndex(nextIndex);
 setDraft(history[nextIndex] ?? DEFAULT_URL);
 setIsLoading(true);
 };

 const refresh = () => {
 setIsLoading(true);
 setReloadKey((value) => value + 1);
 };

 return (
 <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/70 shadow-sm">
 <div className="flex shrink-0 flex-col gap-3 border-b border-border/60 bg-background/70 p-3 backdrop-blur md:flex-row md:items-center">
 <div className="flex items-center gap-1.5">
 <Button
 type="button"
 variant="ghost"
 size="icon"
 className="h-8 w-8 rounded-full"
 onClick={goBack}
 disabled={!canGoBack}
 aria-label="Go back"
 >
 <ArrowLeft className="h-4 w-4" />
 </Button>
 <Button
 type="button"
 variant="ghost"
 size="icon"
 className="h-8 w-8 rounded-full"
 onClick={goForward}
 disabled={!canGoForward}
 aria-label="Go forward"
 >
 <ArrowRight className="h-4 w-4" />
 </Button>
 <Button
 type="button"
 variant="ghost"
 size="icon"
 className="h-8 w-8 rounded-full"
 onClick={refresh}
 aria-label="Reload page"
 >
 <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
 </Button>
 </div>

 <form onSubmit={handleSubmit} className="relative flex min-w-0 flex-1 items-center">
 <Lock className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-emerald-500" />
 <Input
 value={draft}
 onChange={(event) => setDraft(event.target.value)}
 className="h-9 rounded-full border-border/70 bg-muted/40 pl-9 pr-11 font-mono text-xs shadow-inner focus-visible:ring-1"
 placeholder="Search or enter URL"
 spellCheck={false}
 aria-label="Browser address"
 />
 <Button
 type="submit"
 variant="ghost"
 size="icon"
 className="absolute right-1 h-7 w-7 rounded-full text-muted-foreground hover:text-foreground"
 aria-label="Open URL"
 >
 <Search className="h-3.5 w-3.5" />
 </Button>
 </form>

 <Button
 type="button"
 variant="outline"
 size="sm"
 className="h-9 rounded-full gap-2 text-xs"
 onClick={() => window.open(currentUrl, "_blank", "noopener,noreferrer")}
 >
 <ExternalLink className="h-3.5 w-3.5" />
 Open external
 </Button>
 </div>

 <div className="relative min-h-0 flex-1 bg-background">
 {isLoading && (
 <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/70 backdrop-blur-sm">
 <div className="flex items-center gap-2 rounded-full border border-border/60 bg-card px-3 py-2 text-xs text-muted-foreground shadow-sm">
 <Loader2 className="h-3.5 w-3.5 animate-spin" />
 Loading browser…
 </div>
 </div>
 )}
 <iframe
 key={`${currentUrl}-${reloadKey}`}
 title="Browser"
 src={currentUrl}
 className="h-full w-full border-0 bg-white"
 sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
 referrerPolicy="no-referrer-when-downgrade"
 onLoad={() => setIsLoading(false)}
 />
 </div>
 </section>
 );
}
