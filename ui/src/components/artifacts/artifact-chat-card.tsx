/**
 * ArtifactChatCard — in the chat, the artifact a tool call made or changed: its title and kind, and
 * Open, which shows it next to the conversation (the chat stays open beside it).
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, Sparkles } from "lucide-react";
import { useEvents } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { sidebarActions } from "@/hooks/chat-context";
import { artifactLabel, artifactsApi, type ArtifactSummary } from "@/lib/artifacts-api";

export function ArtifactChatCard({ artifactId, updated }: { artifactId: string; updated?: boolean }) {
  const navigate = useNavigate();
  const [artifact, setArtifact] = useState<Pick<ArtifactSummary, "title" | "type" | "kind" | "version"> | null>(null);
  const [gone, setGone] = useState(false);
  const { events } = useEvents(["artifact:changed"], 1);

  useEffect(() => {
    artifactsApi.get(artifactId).then(
      (a) => { setArtifact({ title: a.title, type: a.type, kind: a.kind, version: a.version }); setGone(false); },
      () => setGone(true),
    );
  }, [artifactId, events.length]);

  const open = () => {
    navigate(`/artifacts/${encodeURIComponent(artifactId)}`);
    sidebarActions.setSidebarOpen(true);
  };

  return (
    <div className="my-2 flex items-center gap-3 rounded-lg border border-border/60 bg-card/80 px-3 py-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><Sparkles className="h-4 w-4" /></span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{artifact?.title ?? (gone ? "Artifact deleted" : "Artifact")}</p>
        <p className="text-[11px] text-muted-foreground">
          {artifact ? `${artifactLabel(artifact)} · v${artifact.version}${updated ? " · updated" : ""}` : gone ? "It is no longer available" : "Loading…"}
        </p>
      </div>
      {!gone && (
        <Button size="sm" variant="outline" className="h-8 shrink-0" onClick={open}>
          <ExternalLink className="h-3.5 w-3.5" /> Open
        </Button>
      )}
    </div>
  );
}
