/**
 * Start / Stop / Restart / Reset / Recreate / Delete on computers, for the Computers page and the
 * agent's Computer tab: one computer busy at a time, Reset, Recreate and Delete wait for a
 * confirmation (`pending`, shown by ComputerConfirmDialog), errors become toasts. Stop and Restart
 * of a computer with tasks or sessions running on it are refused by the server (COMPUTER_BUSY): the
 * dialog lists them and offers to do it anyway (force).
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { computerBusyOf, computersApi, type Computer, type ComputerAction, type ComputerBusy } from "@/lib/computers-api";
import type { UseComputersReturn } from "@/hooks/use-computers";

export type PendingComputerAction =
  | { computer: Computer; what: "reset" | "recreate" | "delete" }
  /** Refused because it is busy: confirming does it anyway (force). */
  | { computer: Computer; what: "stop" | "restart"; busy: ComputerBusy };

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
    await guard(computer.id, async () => {
      try {
        upsert(await computersApi.control(computer.id, action));
      } catch (e) {
        const busy = computerBusyOf(e);
        if (!busy || (action !== "stop" && action !== "restart")) throw e;
        setPending({ computer, what: action, busy });
      }
    });
  }, [guard, upsert]);

  const confirm = useCallback(async () => {
    if (!pending) return;
    const { computer, what } = pending;
    setPending(null);
    await guard(computer.id, async () => {
      if (what === "stop" || what === "restart") {
        upsert(await computersApi.control(computer.id, what, { force: true }));
      } else if (what === "reset" || what === "recreate") {
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
