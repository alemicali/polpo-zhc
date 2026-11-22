/** The computer lifecycle actions' labels and icons (shared by the card, the table and the computer's page). */
import { Play, RefreshCw, RotateCcw, RotateCw, Square } from "lucide-react";
import { stopLabel, type Computer, type ComputerAction } from "@/lib/computers-api";

export const ACTION_META: Record<ComputerAction, { label: string; icon: typeof Play }> = {
  start: { label: "Start", icon: Play },
  stop: { label: "Stop", icon: Square },
  restart: { label: "Restart", icon: RefreshCw },
  reset: { label: "Reset", icon: RotateCcw },
  recreate: { label: "Recreate", icon: RotateCw },
};

/** An action's label on this computer ("Hibernate" for a Daytona v2 stop, "Pause" on E2B). */
export function actionLabel(computer: Pick<Computer, "kind" | "providerApi">, action: ComputerAction): string {
  return action === "stop" ? stopLabel(computer) : ACTION_META[action].label;
}
