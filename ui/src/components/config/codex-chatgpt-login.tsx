/**
 * Settings → Harnesses → Codex with "ChatGPT sign-in": sign an agent in with ChatGPT. A terminal on
 * the agent's computer runs `codex login --device-auth` with the agent's CODEX_HOME: the person
 * opens the link it shows, signs in with the ChatGPT account whose plan pays, and enters the code.
 * "Save sign-in" (also when the dialog closes) captures the login from the computer into the vault
 * entry; Polpo writes it into the computer before each run and saves it back when Codex refreshes
 * it. The dashboard only ever sees "signed in / not signed in", never the login.
 */
import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TerminalSession } from "@/pages/coding/terminal-session";
import { harnessesApi, type CodexChatgptLogin, type CodexChatgptStatus } from "@/lib/harnesses-api";

/** Signed in or not (from the vault entry; never its content). */
export function CodexChatgptBadge({ status }: { status: CodexChatgptStatus | undefined }) {
  if (!status) return null;
  return status.signedIn
    ? <Badge variant="secondary" className="text-micro" data-testid="codex-chatgpt-status" title={status.lastRefresh ? `Refreshed ${new Date(status.lastRefresh).toLocaleString()}` : undefined}>signed in</Badge>
    : <Badge variant="outline" className="text-micro" data-testid="codex-chatgpt-status">not signed in</Badge>;
}

/** The sign-in terminal on the agent's computer, and the capture into the vault. */
export function CodexChatgptLoginDialog({ agent, onClose }: { agent: string | null; onClose: (changed: boolean) => void }) {
  const [answer, setAnswer] = useState<{ agent: string; login?: CodexChatgptLogin; error?: string } | null>(null);
  const [state, setState] = useState<string>("loading");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (!agent) return;
    setSaved(null);
    harnessesApi.codexChatgptLogin(agent).then((login) => setAnswer({ agent, login }), (e: Error) => setAnswer({ agent, error: e.message }));
  }, [agent]);
  const current = answer && agent && answer.agent === agent ? answer : null;
  const login = current?.login ?? null;

  const capture = async (quiet: boolean): Promise<boolean> => {
    if (!agent) return false;
    setSaving(true);
    try {
      const r = await harnessesApi.codexChatgptCapture(agent);
      if (r.result === "updated" || r.result === "unchanged") { setSaved(r.message); if (!quiet) toast.success(r.message); return true; }
      if (!quiet) toast.message(r.message);
      return false;
    } catch (e) {
      if (!quiet) toast.error((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!agent} onOpenChange={(open) => { if (!open) void capture(true).then((ok) => onClose(ok)); }}>
      <DialogContent className="sm:max-w-3xl" data-testid="codex-chatgpt-dialog">
        <DialogHeader>
          <DialogTitle>Sign in to ChatGPT · Codex for {agent}</DialogTitle>
          <DialogDescription>
            Codex shows a link and a code: open the link, sign in with the ChatGPT account whose plan pays for this agent's work, and enter the code.
            Then save the sign-in: it is kept in the vault and written into the agent's computer before each run.
          </DialogDescription>
        </DialogHeader>
        {current?.error && <p className="text-xs text-destructive">{current.error}</p>}
        {login && agent && (
          <div className="space-y-2">
            <div className="relative h-80 overflow-hidden rounded-md border" data-testid="codex-chatgpt-terminal">
              <TerminalSession
                sessionId={`codex-chatgpt-login-${agent}`} revision={0} cwd="." active agent="codex-chatgpt-login" harnessAgent={agent}
                onConnectionChange={setState}
              />
            </div>
            <p className="text-micro text-muted-foreground">
              Terminal {login.computer === "host" ? "on this server" : `on ${login.computer}`}: {state} · vault entry <code>{login.credentialRef.owner} / {login.credentialRef.service}</code>
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void capture(false)} disabled={saving} aria-label="Save ChatGPT sign-in">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save sign-in
              </Button>
              {saved && <span className="flex items-center gap-1 text-micro text-success"><CheckCircle2 className="h-3.5 w-3.5" /> {saved}</span>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
