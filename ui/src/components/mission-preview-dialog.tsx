/**
 * MissionPreviewDialog — opens the full MissionDetailView in a large
 * dialog using the in-memory preview data (before the mission is saved).
 *
 * DRY: reuses the exact same component the /missions/:id page renders.
 * Synthesizes a Mission shape from MissionPreviewData + serializes the
 * data to JSON so parseMissionData() inside the view works unchanged.
 */

import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { MissionDetailView } from "@/pages/mission-detail";
import type { MissionPreviewData } from "@/hooks/use-polpo";
import type { Mission } from "@polpo-ai/react";

export function MissionPreviewDialog({
  preview,
  open,
  onOpenChange,
}: {
  preview: MissionPreviewData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();

  // Synthesize a Mission from the preview. Identifier is fake; nothing
  // is persisted yet — the view treats this as a draft blueprint.
  const synthMission = useMemo<Mission>(() => {
    const data = typeof preview.data === "string"
      ? preview.data
      : JSON.stringify(preview.data);
    const now = new Date().toISOString();
    return {
      id: "preview",
      name: preview.name,
      status: "draft",
      data,
      prompt: preview.prompt,
      createdAt: now,
      updatedAt: now,
    } as Mission;
  }, [preview]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!max-w-none w-[98vw] h-[96dvh] sm:max-w-none p-5 sm:p-7 flex flex-col gap-0"
        showCloseButton
      >
        {/* Visually hidden title — required for a11y on shadcn Dialog */}
        <DialogTitle className="sr-only">Mission preview — {preview.name}</DialogTitle>
        <MissionDetailView
          mission={synthMission}
          groupTasks={[]}
          liveDelays={[]}
          variant="dialog"
          navigate={(path) => {
            onOpenChange(false);
            navigate(path);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
