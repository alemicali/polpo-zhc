/**
 * A contact's sheet: who they are (window, opt-in / opt-out, marketing preference, blocked, call
 * permission), the operator's actions (opt-in / opt-out, block / unblock, erase), the conversation
 * (WaTranscript) with reply / react / mark read, and the composer. Live over channel:message-status
 * and channel:wabiz-event.
 */
import { useState } from "react";
import { Ban, Loader2, MessageSquare, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useWaConversation, useWaTemplates, type WaBusinessContact, type WaBusinessMessage } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { cn } from "@/lib/utils";
import { WaTranscript } from "./transcript";
import { WaComposer } from "./composer";

export interface WaContactSheetProps {
  channel: string;
  contact: WaBusinessContact | null;
  onOpenChange: (open: boolean) => void;
  setOptIn: (waId: string, optIn: boolean, source?: string) => Promise<void>;
  setBlocked: (waId: string, blocked: boolean) => Promise<{ done: string[]; failed: Array<{ user: string; error: string }> }>;
  erase: (waId: string) => Promise<void>;
}

export function WaContactSheet({ channel, contact, onOpenChange, setOptIn, setBlocked, erase }: WaContactSheetProps) {
  return (
    <Sheet open={!!contact} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl" data-testid="wabiz-contact-sheet">
        {contact && <ContactBody channel={channel} contact={contact} onClose={() => onOpenChange(false)} setOptIn={setOptIn} setBlocked={setBlocked} erase={erase} />}
      </SheetContent>
    </Sheet>
  );
}

export function ContactBody({ channel, contact, onClose, setOptIn, setBlocked, erase }: Omit<WaContactSheetProps, "contact" | "onOpenChange"> & { contact: WaBusinessContact; onClose: () => void }) {
  const { conversation, isLoading, error, send, sendTemplate, react, markRead, refetch } = useWaConversation(channel, contact.waId, 100);
  const { templates } = useWaTemplates(channel);
  const [replyTo, setReplyTo] = useState<WaBusinessMessage | undefined>();
  const [busy, setBusy] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const c = { ...contact, ...(conversation?.contact ?? {}) };
  const win = conversation?.window ?? contact.window ?? { open: false };
  const optedOut = conversation?.optedOut ?? !!c.optOut;
  const blocked = !!c.blocked;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      await refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2"><MessageSquare className="h-4 w-4" /> {c.name ?? c.waId}</SheetTitle>
        <SheetDescription asChild>
          <div className="flex flex-wrap items-center gap-1.5">
            {c.name && <span className="font-mono">{c.waId}</span>}
            <Badge variant="outline" className={cn("font-normal", win.open ? "border-success/30 bg-success/10 text-success" : "text-muted-foreground")}>
              {win.open ? `Window open${win.closesAt ? ` until ${new Date(win.closesAt).toLocaleString()}` : ""}` : "Window closed"}
            </Badge>
            {optedOut && <Badge variant="outline" className="border-warning/30 bg-warning/10 font-normal text-warning">Opted out</Badge>}
            {c.optIn && <Badge variant="outline" className="border-info/30 bg-info/10 font-normal text-info">Opted in ({c.optIn.source})</Badge>}
            {c.marketing && <Badge variant="outline" className="font-normal">Marketing {c.marketing.value === "stop" ? "stopped" : "resumed"} in WhatsApp</Badge>}
            {blocked && <Badge variant="outline" className="border-destructive/30 bg-destructive/10 font-normal text-destructive" data-testid="wabiz-contact-blocked">Blocked</Badge>}
            {c.callPermission && <Badge variant="outline" className="font-normal">Calls {c.callPermission.response === "accept" ? "allowed" : "declined"}{c.callPermission.permanent ? " (permanent)" : ""}</Badge>}
          </div>
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-4 px-4 pb-4">
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy}
            onClick={() => void run(() => setOptIn(c.waId, optedOut || !c.optIn), optedOut || !c.optIn ? "Opt-in recorded" : "Opt-out recorded")}>
            {optedOut || !c.optIn ? "Record opt-in" : "Record opt-out"}
          </Button>
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={busy} data-testid="wabiz-block-toggle"
            onClick={() => (blocked ? void run(async () => { const r = await setBlocked(c.waId, false); if (r.failed.length) throw new Error(r.failed[0]!.error); }, "Unblocked") : setConfirmBlock(true))}>
            <Ban className="h-3.5 w-3.5" /> {blocked ? "Unblock" : "Block"}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs text-destructive hover:text-destructive" disabled={busy} onClick={() => setErasing(true)}>
            <Trash2 className="h-3.5 w-3.5" /> Erase
          </Button>
          {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>

        {isLoading && !conversation
          ? <div className="flex items-center gap-2 text-caption text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the conversation…</div>
          : error && !conversation
            ? <p className="text-caption text-destructive">{error.message}</p>
            : (
              <WaTranscript channel={channel} messages={conversation?.messages ?? []}
                onReply={(m) => setReplyTo(m)}
                onReact={(m, emoji) => { void react(m.id, emoji).then(() => toast.success(emoji ? `Reacted ${emoji}` : "Reaction removed")).catch((e: Error) => toast.error(e.message)); }}
                onMarkRead={(m) => { void markRead(m.id).then(() => toast.success("Marked read")).catch((e: Error) => toast.error(e.message)); }} />
            )}

        <div className="border-t pt-3">
          <WaComposer windowOpen={win.open} optedOut={optedOut} blocked={blocked} templates={templates}
            {...(replyTo ? { replyTo } : {})} onClearReply={() => setReplyTo(undefined)} send={send} sendTemplate={sendTemplate} />
        </div>
      </div>
      <ConfirmDialog open={confirmBlock} onOpenChange={setConfirmBlock} title={`Block ${c.name ?? c.waId}?`}
        description="Meta blocks only people who wrote in the last 24 hours. A blocked contact can no longer write to the number, and nothing is sent to them."
        confirmLabel="Block" destructive loading={busy}
        onConfirm={() => void run(async () => { const r = await setBlocked(c.waId, true); if (r.failed.length) throw new Error(r.failed[0]!.error); }, "Blocked").then(() => setConfirmBlock(false))} />
      <ConfirmDialog open={erasing} onOpenChange={setErasing} title={`Erase ${c.waId}?`}
        description="This deletes the contact and every message kept for them (a GDPR erasure request). It cannot be undone."
        confirmLabel="Erase" destructive loading={busy}
        onConfirm={() => void run(() => erase(c.waId), "Contact erased").then(() => { setErasing(false); onClose(); })} />
    </>
  );
}
