/** Confirmation for the destructive computer actions (Reset, Delete). */
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PendingComputerAction } from "@/hooks/use-computer-actions";

export function ComputerConfirmDialog({
  pending, onCancel, onConfirm,
}: { pending: PendingComputerAction | null; onCancel: () => void; onConfirm: () => void }) {
  const reset = pending?.what === "reset";
  return (
    <Dialog open={!!pending} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{reset ? `Reset ${pending?.computer.name}?` : `Delete ${pending?.computer.name}?`}</DialogTitle>
          <DialogDescription>
            {reset
              ? "Its machine is deleted and a new one is created: everything on its disk (files, installed tools, browser sign-ins) is lost."
              : "The computer and its machine are deleted, with everything on its disk. This cannot be undone."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm}>{reset ? "Reset" : "Delete"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
