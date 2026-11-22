/** Confirmation for the destructive computer actions (Reset, Recreate, Delete / Remove from Polpo). */
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PendingComputerAction } from "@/hooks/use-computer-actions";

function copy(pending: PendingComputerAction | null): { title: string; description: string; confirm: string } {
  const name = pending?.computer.name ?? "";
  switch (pending?.what) {
    case "reset":
      return {
        title: `Reset ${name}?`,
        description: "Its machine is deleted and a new one is created: everything on its disk (files, installed tools, browser sign-ins) is lost.",
        confirm: "Reset",
      };
    case "recreate":
      return {
        title: `Recreate ${name}?`,
        description: "Its machine was deleted at the provider. A new one is made from its image: what the old one had (files, installed tools, browser sign-ins) is lost and does not come back.",
        confirm: "Recreate",
      };
    default:
      return pending?.computer.status === "deleted"
        ? {
          title: `Remove ${name} from Polpo?`,
          description: "Its machine is already gone at the provider. The computer is removed from Polpo; agents that may use it lose it.",
          confirm: "Remove",
        }
        : {
          title: `Delete ${name}?`,
          description: "The computer and its machine are deleted, with everything on its disk. This cannot be undone.",
          confirm: "Delete",
        };
  }
}

export function ComputerConfirmDialog({
  pending, onCancel, onConfirm,
}: { pending: PendingComputerAction | null; onCancel: () => void; onConfirm: () => void }) {
  const { title, description, confirm } = copy(pending);
  return (
    <Dialog open={!!pending} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm}>{confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
