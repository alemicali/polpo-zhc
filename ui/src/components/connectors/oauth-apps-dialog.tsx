/**
 * Shared OAuth apps (Google, and vendors without self-registration): the client ids saved once
 * and reused by every connector of that vendor. Replace the credentials or remove an app; the
 * secret is write-only.
 */
import { useState } from "react";
import { toast } from "sonner";
import { KeyRound, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { connectorsApi, type OAuthApp } from "@/lib/connectors-api";
import { CopyField, Field } from "./connect-dialog";

function AppRow({ app, onChanged }: { app: OAuthApp; onChanged: () => Promise<void> | void }) {
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState(app.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const run = async (what: "save" | "remove", fn: () => Promise<unknown>) => {
    setBusy(what);
    try { await fn(); await onChanged(); setEditing(false); setClientSecret(""); }
    catch (reason) { toast.error(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(null); }
  };
  return (
    <li className="space-y-2 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{app.name ?? app.id} <span className="font-mono text-xs font-normal text-muted-foreground">{app.id}</span></p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{app.clientId}{app.hasSecret ? " · secret set" : " · no secret"}</p>
        </div>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing((v) => !v)}>{editing ? "Cancel" : "Replace"}</Button>
        <Button
          size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" aria-label={`Remove ${app.id}`} disabled={!!busy}
          onClick={() => setConfirming(true)}
        >
          {busy === "remove" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {editing && (
        <form
          className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (!clientId.trim()) return;
            void run("save", () => connectorsApi.saveOAuthApp(app.id, { clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) }));
          }}
        >
          <Field label="Client ID"><Input value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} /></Field>
          <Field label="Client secret"><Input type="password" value={clientSecret} placeholder="unchanged" onChange={(e) => setClientSecret(e.target.value)} autoComplete="new-password" /></Field>
          <Button type="submit" size="sm" disabled={!!busy}>{busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />} Save</Button>
        </form>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Remove the "${app.id}" OAuth app?`}
        description="Its connectors keep their current sign-in, but cannot sign in again until it is set up again."
        confirmLabel="Remove"
        destructive
        loading={busy === "remove"}
        onConfirm={() => void run("remove", () => connectorsApi.removeOAuthApp(app.id)).then(() => setConfirming(false))}
      />
    </li>
  );
}

export function OAuthAppsDialog({
  open, onOpenChange, apps, redirectUri, onChanged,
}: { open: boolean; onOpenChange: (open: boolean) => void; apps: OAuthApp[]; redirectUri: string; onChanged: () => Promise<void> | void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>OAuth apps</DialogTitle>
          <DialogDescription>
            Clients registered once with a vendor (Google, Slack, GitHub…) and shared by its connectors. They are set up the first time you connect one of them.
          </DialogDescription>
        </DialogHeader>
        {redirectUri && <CopyField label="Redirect URI to register" value={redirectUri} />}
        {apps.length === 0
          ? <p className="py-4 text-center text-sm text-muted-foreground">No OAuth apps yet.</p>
          : <ul className="divide-y rounded-lg border">{apps.map((app) => <AppRow key={app.id} app={app} onChanged={onChanged} />)}</ul>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
