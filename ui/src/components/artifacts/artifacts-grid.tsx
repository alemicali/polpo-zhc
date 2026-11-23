import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Play } from "lucide-react";
import { artifactPath, type ArtifactActions } from "@/hooks/use-artifact-actions";
import { artifactLabel, artifactsApi, artifactWorkspace, type ArtifactSummary } from "@/lib/artifacts-api";
import { absoluteTime, relativeTime } from "@/lib/artifacts-list";
import { ArtifactIcon } from "./artifact-icon";
import { ArtifactRowMenu, LegacyBadge, type ArtifactRowInfo } from "./artifacts-browser";
import { drawMotionFrame, parseMotion, type MotionProject } from "./artifact-motion-model";
import { readWorkbook, type Sheet } from "./artifact-sheets-model";
import { SLIDE_THEMES } from "./artifact-content-palette";
import { parseSlides, type Slide } from "./artifact-slides-format";

const motionPosterWidth = 360;
const motionPosterHeight = 203;
const sheetRows = [1, 2, 3, 4, 5];
const sheetColumns = ["A", "B", "C", "D"];

function DocumentPoster({ content }: { content: string }) {
  const excerpt = content.replace(/^---\n[\s\S]*?\n---\n/, "").split(/\r?\n/).filter((line) => line.trim()).slice(0, 12);
  return (
    <div className="absolute inset-x-[17%] top-4 rounded-t-xs border border-border bg-background px-[7%] py-4 text-foreground shadow-card">
      {excerpt.map((line, index) => {
        const heading = /^#{1,6}\s+/.test(line);
        const text = line.replace(/^#{1,6}\s+/, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`_]/g, "").slice(0, 140);
        return <p key={index} className={heading ? "mb-1 line-clamp-2 font-heading text-xs font-semibold" : "mb-1 line-clamp-2 text-micro text-muted-foreground"}>{text}</p>;
      })}
    </div>
  );
}

function SlidePoster({ slide }: { slide: Slide }) {
  const { bg, fg, accent } = SLIDE_THEMES[slide.theme ?? "light"];
  const titleSlide = slide.layout === "title";
  return (
    <div className="relative size-full overflow-hidden [container-type:inline-size]" style={{ backgroundColor: bg, color: fg }}>
      <div className="absolute left-[8%] top-[8%] h-[1%] w-[7%]" style={{ backgroundColor: accent }} />
      <div className="absolute inset-x-[8%] line-clamp-2 text-[5.2cqw] font-semibold leading-tight" style={{ top: titleSlide ? "29%" : "14%" }}>{slide.title}</div>
      <div className="absolute inset-x-[8%] grid gap-[6%] whitespace-pre-wrap text-[2.7cqw] leading-snug" style={{ top: titleSlide ? "56%" : "38%", gridTemplateColumns: slide.layout === "split" ? "1fr 1fr" : "1fr" }}>
        <p className="line-clamp-5">{slide.body}</p>
        {slide.layout === "split" && <p className="line-clamp-5">{slide.secondary}</p>}
      </div>
      {slide.elements?.map((element) => {
        const text = element.type === "text";
        return (
          <div key={element.id} className="absolute overflow-hidden whitespace-pre-wrap break-words" style={{
            left: `${element.x}%`, top: `${element.y}%`, width: `${element.w}%`, height: `${element.h}%`,
            color: element.color ?? fg, fontSize: `${element.fontSize ?? 3}cqw`,
            backgroundColor: text ? undefined : element.color ?? accent, borderRadius: element.type === "ellipse" ? "50%" : undefined,
          }}>{text ? element.text : undefined}</div>
        );
      })}
    </div>
  );
}

function SheetPoster({ sheet }: { sheet: Sheet }) {
  return (
    <div className="absolute inset-x-[7%] top-4 overflow-hidden rounded-t-xs border border-border bg-background shadow-card">
      <div className="grid grid-cols-[1.2rem_repeat(4,minmax(0,1fr))] text-micro">
        <span className="border-b border-r bg-muted" />
        {sheetColumns.map((column) => <span key={column} className="border-b border-r bg-muted text-center font-medium text-muted-foreground">{column}</span>)}
        {sheetRows.flatMap((row) => [
          <span key={row} className="border-b border-r bg-muted text-center text-muted-foreground">{row}</span>,
          ...sheetColumns.map((column) => {
            const value = sheet.cells[column + row] ?? "";
            return <span key={column + row} className="truncate border-b border-r px-0.5 text-foreground">{value}</span>;
          }),
        ])}
      </div>
      <p className="inline-block max-w-full truncate border-t-2 border-primary px-2 py-0.5 text-micro font-medium">{sheet.name}</p>
    </div>
  );
}

function MotionPoster({ project }: { project: MotionProject }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scale = Math.min(motionPosterWidth / project.width, motionPosterHeight / project.height);
  const width = Math.round(scale * project.width);
  const height = Math.round(scale * project.height);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.scale(width / project.width, height / project.height);
    drawMotionFrame(context, project, [0, project.scenes[0].duration], 0, {});
    context.resetTransform();
  }, [project, height, width]);
  return (
    <div className="flex size-full items-center justify-center bg-stage">
      <canvas ref={canvas} width={width} height={height} className="max-h-full max-w-full object-contain" />
      <span className="absolute bottom-2 right-2 grid size-6 place-items-center rounded-pill bg-stage/60 text-stage-foreground"><Play className="size-3" /></span>
    </div>
  );
}

function StaticHtmlPoster({ content }: { content: string }) {
  const [srcDoc, setSrcDoc] = useState("");
  useEffect(() => {
    let active = true;
    void import("./artifact-static-preview").then(({ artifactStaticPreview }) => {
      if (active) setSrcDoc(artifactStaticPreview(content));
    }).catch(() => {});
    return () => { active = false; };
  }, [content]);
  // A desktop-size viewport keeps page breakpoints and text density in proportion to the card.
  return srcDoc ? (
    <div className="absolute inset-0 overflow-hidden [container-type:inline-size]">
      <iframe srcDoc={srcDoc} sandbox="" referrerPolicy="no-referrer" tabIndex={-1} title="Static artifact thumbnail"
        className="pointer-events-none absolute left-0 top-0 h-[576px] w-[1024px] origin-top-left scale-[calc(tan(atan2(100cqw,1024px)))] border-0 bg-canvas" />
    </div>
  ) : null;
}

function PreviewContent({ artifact, content }: { artifact: ArtifactSummary; content: string }) {
  const workspace = artifactWorkspace(artifact, content);
  if (workspace === "slides") {
    const deck = parseSlides(content);
    if (deck) return <SlidePoster slide={deck.slides[0]} />;
  } else if (workspace === "sheets") {
    const workbook = readWorkbook(content);
    if (workbook) return <SheetPoster sheet={workbook.sheets[0]} />;
  } else if (workspace === "motion") {
    const project = parseMotion(content);
    if (project) return <MotionPoster project={project} />;
  } else if (artifact.type === "doc" && content.trim()) {
    return <DocumentPoster content={content} />;
  } else if (artifact.type === "html" && content.trim()) {
    return <StaticHtmlPoster content={content} />;
  } else if (artifact.type === "svg" && /<\/svg>\s*$/i.test(content)) {
    return <img alt="" decoding="async" className="size-full object-contain p-4" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`} />;
  } else if (artifact.type === "mermaid" && content.trim()) {
    return <pre className="absolute inset-0 overflow-hidden whitespace-pre-wrap p-[8%] text-micro text-muted-foreground">{content.slice(0, 500)}</pre>;
  }
  return null;
}

const ArtifactThumbnail = memo(function ArtifactThumbnail({ artifact }: { artifact: ArtifactSummary }) {
  const host = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState("");

  useEffect(() => {
    const element = host.current;
    if (!element || artifact.type === "view") return;
    const controller = new AbortController();
    const load = () => {
      void artifactsApi.preview(artifact.id, controller.signal).then(
        (next) => { if (!controller.signal.aborted && typeof next?.content === "string") setContent(next.content); },
        () => { /* The type icon stays visible when the preview is unavailable. */ },
      );
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer?.disconnect();
        load();
      }
    });
    if (observer) observer.observe(element);
    else load();
    return () => { observer?.disconnect(); controller.abort(); };
  }, [artifact.id, artifact.type, artifact.updatedAt]);

  const preview = useMemo(() => content ? <PreviewContent artifact={artifact} content={content} /> : null, [artifact, content]);
  return (
    <div ref={host} aria-hidden="true" className="relative isolate aspect-video overflow-hidden border-b border-border/65 bg-muted">
      <div className="absolute inset-0 grid place-items-center text-muted-foreground/55"><ArtifactIcon artifact={artifact} className="size-9" /></div>
      {preview && <div className="absolute inset-0">{preview}</div>}
    </div>
  );
});

export function ArtifactsGrid({ items, info, actions, now }: {
  items: ArtifactSummary[];
  info: (artifact: ArtifactSummary) => ArtifactRowInfo;
  actions: ArtifactActions;
  now?: number;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto pb-bottom-nav">
      <ul aria-label="Artifact previews" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((artifact) => {
          const { author } = info(artifact);
          return (
            <li key={artifact.id} className="group relative overflow-hidden rounded-lg border border-border/70 bg-card transition-colors hover:border-primary/45 focus-within:border-primary">
              <Link to={artifactPath(artifact.id)} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                <ArtifactThumbnail artifact={artifact} />
                <div className="flex min-w-0 items-start gap-2 px-3 py-2.5 pr-10">
                  <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"><ArtifactIcon artifact={artifact} className="size-3.5" /></span>
                  <span className="min-w-0 grow">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm font-medium" title={artifact.title}>{artifact.title}</span>
                      {artifact.type === "view" && <LegacyBadge />}
                    </span>
                    <span className="block truncate text-caption text-muted-foreground" title={author}>
                      {artifactLabel(artifact)} <span aria-hidden="true">·</span> <time dateTime={artifact.updatedAt} title={absoluteTime(artifact.updatedAt)}>{relativeTime(artifact.updatedAt, now)}</time>
                    </span>
                  </span>
                </div>
              </Link>
              <ArtifactRowMenu artifact={artifact} actions={actions} className="absolute bottom-2.5 right-2" />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
