/**
 * Start / Stop / Restart / Reset / Recreate / Delete on computers, for the Computers page and the
 * agent's Computer tab: one computer busy at a time, Reset, Recreate and Delete wait for a
 * confirmation (`pending`, shown by ComputerConfirmDialog), errors become toasts.
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { computersApi, type Computer, type ComputerAction } from "@/lib/computers-api";
import type { UseComputersReturn } from "@/hooks/use-computers";

export type PendingComputerAction = { computer: Computer; what: "reset" | "recreate" | "delete" };

export function useComputerActions({ upsert, drop, refresh }: Pick<UseComputersReturn, "upsert" | "drop" | "refresh">) {
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingComputerAction | null>(null);

  /** Run `fn` with the computer marked busy; an error becomes a toast (and a refresh). */
  const guard = useCallback(async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
      void refresh(false);
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const run = useCallback(async (computer: Computer, action: ComputerAction) => {
    if (action === "reset" || action === "recreate") { setPending({ computer, what: action }); return; }
    await guard(computer.id, async () => { upsert(await computersApi.control(computer.id, action)); });
  }, [guard, upsert]);

  const confirm = useCallback(async () => {
    if (!pending) return;
    const { computer, what } = pending;
    setPending(null);
    await guard(computer.id, async () => {
      if (what === "reset" || what === "recreate") {
        const c = await computersApi.control(computer.id, what);
        upsert(c);
        // the wipe is done but its new machine comes on the next use: said, not an error
        if (c.note) toast.info(c.note);
        else if (what === "recreate") toast.success(`${computer.name} has a new machine`);
      } else {
        await computersApi.remove(computer.id);
        drop(computer.id);
        toast.success(computer.status === "deleted" ? `Removed ${computer.name} from Polpo` : `Deleted ${computer.name}`);
      }
    });
  }, [pending, guard, upsert, drop]);

  return { busy, pending, setPending, guard, run, confirm };
}
