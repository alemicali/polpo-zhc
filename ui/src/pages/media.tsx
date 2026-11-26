/**
 * Media: images generated and edited through the instance's image model (the media primitive).
 *
 * - Try it: a prompt, a size and how many variants → the images (a real model call, logged).
 * - History: every request with its images and provenance (who asked and from where, the prompt,
 *   the model, the size, the seed, the cost); one opens with its details.
 * Deep link: ?image=<id> opens that request.
 */
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, Download, Images, Loader2, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { useGenerateImage, useMediaLog } from "@polpo-ai/react";
import type { MediaLogEntry } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/shared/page-header";
import { mediaCallerText } from "@/lib/media";
import { cn } from "@/lib/utils";

const selectClass = "h-8 rounded-md border bg-transparent px-2 text-xs";
const SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"];
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

function Thumbs({ entry, imageUrl, large }: { entry: Pick<MediaLogEntry, "id" | "assets" | "prompt">; imageUrl: (id: string, i: number, o?: { thumb?: boolean; download?: boolean }) => string; large?: boolean }) {
  if (!entry.assets.length) return null;
  return (
    <div className={cn("grid gap-2", large ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-4 sm:grid-cols-6")}>
      {entry.assets.map((a) => (
        <a key={a.index} href={imageUrl(entry.id, a.index)} target="_blank" rel="noreferrer" className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-control">
          <img src={imageUrl(entry.id, a.index, { thumb: !large })} alt={`${entry.prompt.slice(0, 80)} (${a.index + 1})`} loading="lazy"
            className={cn("w-full rounded-control bg-muted/40 object-cover", !large && "aspect-square")} data-testid="media-image" />
        </a>
      ))}
    </div>
  );
}

function Playground({ configured, onDone }: { configured: boolean; onDone: () => void }) {
  const { generate, result, isGenerating, error, imageUrl } = useGenerateImage();
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("auto");
  const [n, setN] = useState("1");
  const [seed, setSeed] = useState("");
  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 shadow-card" data-testid="media-playground">
      <div>
        <h2 className="text-h3 font-heading">Try it</h2>
        <p className="text-caption text-muted-foreground">Describe an image. Each run is a real model call (it costs money); the images are kept with their prompt and cost.</p>
      </div>
      <Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="A lighthouse at dawn, watercolor" aria-label="Prompt" />
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectClass} value={size} onChange={(e) => setSize(e.target.value)} aria-label="Size">
          {SIZES.map((s) => <option key={s} value={s}>{s === "auto" ? "Size: the model's" : s}</option>)}
        </select>
        <select className={selectClass} value={n} onChange={(e) => setN(e.target.value)} aria-label="Variants">
          {["1", "2", "3", "4"].map((v) => <option key={v} value={v}>{v} {v === "1" ? "image" : "images"}</option>)}
        </select>
        <Input className="h-8 w-28" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="Seed" aria-label="Seed" inputMode="numeric" />
        <Button size="sm" disabled={!prompt.trim() || isGenerating} onClick={() => {
          void generate({ prompt: prompt.trim(), ...(size !== "auto" ? { size } : {}), n: Number(n), ...(seed.trim() ? { seed: Math.floor(Number(seed)) } : {}) })
            .then(onDone, (e: Error) => toast.error(e.message));
        }}>{isGenerating && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Generate</Button>
        {!configured && <span className="text-caption text-muted-foreground">No image model is configured yet: <Link className="underline" to="/config?section=media">set one in Settings</Link>.</span>}
      </div>
      {error && <p className="flex items-start gap-1.5 text-sm text-destructive" role="alert"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error.message}</p>}
      {result && (
        <div className="space-y-2 border-t pt-3" data-testid="media-result">
          <p className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
            <span className="font-mono">{result.model}</span><span className="tabular-nums">${result.costUsd.toFixed(4)}</span><span className="tabular-nums">{result.latencyMs} ms</span>
            {result.usedFallback && <Badge variant="outline" className="text-micro font-normal text-info">Fallback model</Badge>}
          </p>
          <Thumbs entry={{ id: result.id, assets: result.images, prompt }} imageUrl={imageUrl} large />
        </div>
      )}
    </section>
  );
}

function Detail({ e, imageUrl }: { e: MediaLogEntry; imageUrl: (id: string, i: number, o?: { thumb?: boolean; download?: boolean }) => string }) {
  return (
    <div className="space-y-3 pt-2" data-testid="media-detail">
      {e.status === "error" ? <p className="text-sm text-destructive">{e.error}</p> : <Thumbs entry={e} imageUrl={imageUrl} large />}
      <dl className="grid gap-x-4 gap-y-1 text-caption sm:grid-cols-[8rem_1fr]">
        <dt className="text-muted-foreground">Prompt</dt><dd className="whitespace-pre-wrap break-words">{e.prompt}{e.promptTruncated ? "…" : ""}</dd>
        <dt className="text-muted-foreground">Model</dt><dd className="font-mono">{e.model}{e.usedFallback ? " (fallback)" : ""}</dd>
        <dt className="text-muted-foreground">Asked by</dt><dd>{mediaCallerText(e)}</dd>
        {e.size && <><dt className="text-muted-foreground">Size</dt><dd>{e.size}</dd></>}
        {e.seed !== undefined && <><dt className="text-muted-foreground">Seed</dt><dd>{e.seed}</dd></>}
        {e.inputs?.length ? <><dt className="text-muted-foreground">Inputs</dt><dd className="break-words">{e.inputs.join(", ")}</dd></> : null}
        <dt className="text-muted-foreground">Cost</dt><dd className="tabular-nums">${e.costUsd.toFixed(4)} · {e.latencyMs} ms</dd>
        {e.assets.map((a) => (
          <div key={a.index} className="contents">
            <dt className="text-muted-foreground">Image {a.index + 1}</dt>
            <dd className="flex flex-wrap items-center gap-2"><span className="font-mono">.polpo/{a.path}</span><span>{a.width && a.height ? `${a.width}×${a.height} · ` : ""}{Math.round(a.bytes / 1024)} KB</span>
              <a className="inline-flex items-center gap-1 underline" href={imageUrl(e.id, a.index, { download: true })}><Download className="h-3 w-3" /> Download</a></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function MediaPage() {
  const [params, setParams] = useSearchParams();
  const { page, status, isLoading, error, refetch } = useMediaLog({ limit: 60 });
  const { imageUrl } = useGenerateImage();
  const openId = params.get("image") ?? undefined;
  const open = (id: string | undefined) => {
    const next = new URLSearchParams(params);
    if (id) next.set("image", id); else next.delete("image");
    setParams(next, { replace: true });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <PageHeader title="Media" icon={Images}
        description="Images generated and edited with the instance's image model, by people, agents, missions, MCP clients and Polpo's chat — each with its prompt, model, cost and who asked."
        actions={<Button size="sm" variant="outline" asChild><Link to="/config?section=media"><Settings2 className="h-3.5 w-3.5" /> Settings</Link></Button>} />

      <p className="text-caption text-muted-foreground" data-testid="media-status">
        {status?.configured
          ? <>Image model <span className="font-mono text-foreground">{status.model}</span>{status.fallbackModel ? <> · fallback <span className="font-mono">{status.fallbackModel}</span></> : null}{status.key && (status.key.ok ? ` · key from ${status.key.detail}` : <span className="text-warning"> · {status.key.detail}</span>)}</>
          : status ? "No image model is configured: image requests are refused until one is set." : null}
      </p>
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      <Playground configured={!!status?.configured} onDone={() => void refetch()} />

      <section className="space-y-2" data-testid="media-log">
        <h2 className="text-h3 font-heading">History {page ? <span className="text-caption text-muted-foreground">({page.total})</span> : null}</h2>
        {isLoading && !page ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : !page?.entries.length ? (
          <p className="py-8 text-center text-sm text-muted-foreground" data-testid="media-empty">No images yet.</p>
        ) : page.entries.map((e) => (
          <div key={e.id} className="border-b py-2 last:border-b-0" data-entry={e.id}>
            <button type="button" className="flex w-full flex-wrap items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => open(openId === e.id ? undefined : e.id)}>
              {e.assets[0]
                ? <img src={imageUrl(e.id, 0, { thumb: true })} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded-control bg-muted/40 object-cover" />
                : <span className="h-10 w-10 shrink-0 rounded-control bg-muted/40" />}
              <span className={cn("min-w-0 flex-1 truncate text-sm", e.status === "error" && "text-destructive")}>{e.status === "error" ? e.error : e.prompt}</span>
              {e.kind === "edit" && <Badge variant="outline" className="text-micro font-normal">Edit</Badge>}
              <span className="text-caption text-muted-foreground">{mediaCallerText(e)} · {when(e.at)} · ${e.costUsd.toFixed(4)}</span>
            </button>
            {openId === e.id && <Detail e={e} imageUrl={imageUrl} />}
          </div>
        ))}
      </section>
    </div>
  );
}
