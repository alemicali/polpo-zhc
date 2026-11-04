/**
 * ArtifactFrame — an html artifact, running isolated (sandbox without same-origin, a strict CSP),
 * answering its `polpo` bridge: data calls go to the server with the rights of the artifact's author.
 * It is told to reload its data every refreshSeconds and when a data source changes, and gets the theme.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useEvents } from "@polpo-ai/react";
import { useTheme } from "@/hooks/use-theme";
import { ARTIFACT_CHANNEL, artifactFrameDoc } from "@/lib/artifact-frame-doc";
import { artifactsApi, type ArtifactDataMethod } from "@/lib/artifacts-api";

const METHODS: readonly ArtifactDataMethod[] = ["sources", "describe", "query", "sql"];

export function ArtifactFrame({ artifactId, html, refreshSeconds, refreshKey = 0, title }: {
  artifactId: string;
  html: string;
  refreshSeconds?: number;
  /** Change it to ask the page to reload its data. */
  refreshKey?: number;
  title: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const { resolved } = useTheme();
  const theme: "light" | "dark" = resolved === "dark" ? "dark" : "light";
  // the document is built once per content: theme changes are sent, not reloaded
  const [themeAtLoad] = useState(theme);
  const srcDoc = useMemo(() => artifactFrameDoc(html, themeAtLoad), [html, themeAtLoad]);
  const { events } = useEvents(["data-source:changed"], 1);

  const post = (message: Record<string, unknown>) =>
    frameRef.current?.contentWindow?.postMessage({ channel: ARTIFACT_CHANNEL, ...message }, "*");

  // the bridge: only messages from this frame, only the data methods
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const m = e.data as { channel?: string; type?: string; id?: number; method?: string; params?: unknown };
      if (!m || m.channel !== ARTIFACT_CHANNEL || m.type !== "call" || typeof m.id !== "number") return;
      const method = m.method as ArtifactDataMethod;
      if (!METHODS.includes(method)) {
        post({ type: "result", id: m.id, ok: false, error: `Unknown method ${String(m.method)}` });
        return;
      }
      artifactsApi.data(artifactId, method, m.params ?? {}).then(
        (data) => post({ type: "result", id: m.id, ok: true, data }),
        (err: Error) => post({ type: "result", id: m.id, ok: false, error: err.message }),
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [artifactId]);

  useEffect(() => { post({ type: "theme", theme }); }, [theme]);

  // reload the data: on request, when a source changes, and every refreshSeconds
  useEffect(() => { if (refreshKey > 0) post({ type: "refresh" }); }, [refreshKey]);
  useEffect(() => { if (events.length > 0) post({ type: "refresh" }); }, [events]);
  useEffect(() => {
    if (!refreshSeconds || refreshSeconds < 10) return;
    const timer = setInterval(() => post({ type: "refresh" }), refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [refreshSeconds]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-popups allow-modals"
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-background"
    />
  );
}
