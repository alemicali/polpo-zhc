/**
 * Settings → Harnesses → CLI accounts: the CLI engine's personal sign-ins (the official Claude Code
 * and Codex programs). An account is a config directory on a computer; Polpo never sees a token.
 * "Sign in" opens a terminal on the account's computer (this server, or a remote computer through
 * its provider's PTY) running `claude auth login` / `codex login --device-auth` for that directory:
 * the person completes Anthropic's / OpenAI's own sign-in.
 * Each row shows the installed version and who is signed in; "Install" runs the official installer.
 * A personal sign-in runs only work its owner started (Anthropic's and OpenAI's terms).
 */
import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, LogOut, Plus, RefreshCw, Download, Trash2, Terminal as TerminalIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { BrandIcon } from "@/components/shared/brand-icon";
import { TerminalSession } from "@/pages/coding/terminal-session";
import { CLI_NAMES, harnessesApi, type CliAccountView, type CliId, type CliLogin, type CliOverview } from "@/lib/harnesses-api";
import { computersApi } from "@/lib/computers-api";

const selectClass = "h-8 rounded-md border bg-transparent px-2 text-xs";
const brandOf = (cli: CliId): "claude-code" | "codex" => (cli === "claude" ? "claude-code" : "codex");

/** The account's state in a word (signed in as…, not signed in, not installed). */
export function CliAccountStatusBadge({ account }: { account: Pick<CliAccountView, "report"> }) {
  const r = account.report;
  if (!r) return null;
  if (!r.installed) return <Badge variant="destructive" className="text-micro">not installed</Badge>;
  if (r.status?.signedIn) {
    return <Badge variant="secondary" className="text-micro" title={r.status.detail}>signed in{r.status.who ? ` as ${r.status.who}` : ""}{r.status.plan ? ` · ${r.status.plan}` : ""}</Badge>;
  }
  return <Badge variant="outline" className="text-micro">not signed in</Badge>;
}

/** The sign-in terminal on the account's computer (this server or a remote one). */
export function CliSignInDialog({ account, onClose }: { account: CliAccountView | null; onClose: () => void }) {
  // what the server says for this account (kept per account: a stale answer is not shown for another)
  const [answer, setAnswer] = useState<{ id: string; login?: CliLogin; error?: string } | null>(null);
  const [state, setState] = useState<string>("loading");
  useEffect(() => {
    if (!account) return;
    const id = account.id;
    harnessesApi.cliLogin(id).then((login) => setAnswer({ id, login }), (e: Error) => setAnswer({ id, error: e.message }));
  }, [account]);
  const current = answer && account && answer.id === account.id ? answer : null;
  const login = current?.login ?? null;
  const error = current?.error ?? null;
  return (
    <Dialog open={!!account} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-3xl" data-testid="cli-signin-dialog">
        <DialogHeader>
          <DialogTitle>Sign in {account ? CLI_NAMES[account.cli] : ""}{account?.label ? ` · ${account.label}` : ""}</DialogTitle>
          <DialogDescription>
            {account?.cli === "claude"
              ? "Claude Code shows a link: open it, sign in with your own Anthropic account, and paste the code back here. "
              : "Codex shows a link and a code: open it and sign in with your own ChatGPT account. "}
            The sign-in stays in {account?.configDir} on {account?.computer}; Polpo never reads it.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {login?.mode === "command" && (
          <div className="space-y-2 text-xs">
            <p>{login.note}</p>
            <code className="block rounded-md border bg-muted p-2">{login.command}</code>
          </div>
        )}
        {login?.mode === "terminal" && account && (
          <div className="space-y-1">
            <div className="relative h-80 overflow-hidden rounded-md border" data-testid="cli-signin-terminal">
              <TerminalSession
                sessionId={`cli-login-${account.id}`} revision={0} cwd="." active agent="cli-login" cliAccount={account.id}
                onConnectionChange={setState}
              />
            </div>
            <p className="text-micro text-muted-foreground">Terminal{login.computer ? ` on ${login.computer}` : ""}: {state} · <code>{login.command}</code></p>
            {login.note && <p className="text-micro text-muted-foreground" data-testid="cli-signin-remote-note">{login.note}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function CliAccountsSection() {
  const [data, setData] = useState<CliOverview | null>(null);
  const [computers, setComputers] = useState<string[]>([]);
  const [draft, setDraft] = useState<{ cli: CliId; computer: string; label: string }>({ cli: "claude", computer: "host", label: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<CliAccountView | null>(null);
  const [removing, setRemoving] = useState<CliAccountView | null>(null);

  const load = useCallback(async () => {
    try { setData(await harnessesApi.cliAccounts()); } catch (e) { toast.error((e as Error).message); }
  }, []);
  useEffect(() => {
    void load();
    computersApi.list(false).then((l) => setComputers((l ?? []).map((c) => c.id))).catch(() => setComputers([]));
  }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try { await fn(); if (done) toast.success(done); await load(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <Card className="gap-0 py-0" data-testid="cli-accounts"><CardContent className="space-y-3 px-4 py-3 text-xs">
      <div className="flex items-center gap-2">
        <KeyRound className="h-3.5 w-3.5" />
        <span className="font-medium">CLI accounts</span>
        <span className="text-muted-foreground">the official Claude Code / Codex program, signed in with your own plan</span>
        <Button size="icon" variant="ghost" className="ml-auto h-6 w-6" onClick={() => void load()} aria-label="Refresh CLI accounts"><RefreshCw className="h-3 w-3" /></Button>
      </div>
      <p className="text-muted-foreground">
        A personal sign-in runs only work its owner starts: never other members, channel customers or schedules
        (Anthropic's and OpenAI's terms). Polpo stores the account's directory, never a token. For shared work use an API key above.
      </p>

      {!data ? <Loader2 className="h-4 w-4 animate-spin" /> : (data.accounts ?? []).length === 0 ? (
        <p className="text-muted-foreground">No CLI accounts yet.</p>
      ) : (data.accounts ?? []).map((a) => (
        <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-2" data-testid={`cli-account-${a.id}`}>
          <BrandIcon name={brandOf(a.cli)} size={16} />
          <span className="font-medium">{a.label || a.id}</span>
          <span className="text-muted-foreground">{CLI_NAMES[a.cli]} on {a.computer} · {a.owner}{a.report?.version ? ` · v${a.report.version}` : ""}</span>
          <CliAccountStatusBadge account={a} />
          {a.agents.length > 0 && <span className="text-muted-foreground">agents: {a.agents.join(", ")}</span>}
          <div className="ml-auto flex gap-1">
            {a.report && !a.report.installed && (
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy === `install-${a.id}`}
                onClick={() => void act(`install-${a.id}`, () => harnessesApi.cliInstall(a.cli, a.computer).then((r) => { if (!r.ok) throw new Error(r.output || "Install failed"); }), `${CLI_NAMES[a.cli]} installed`)}>
                {busy === `install-${a.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />} Install
              </Button>
            )}
            {a.manageable && (
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setSignIn(a)} data-testid={`cli-signin-${a.id}`}>
                <TerminalIcon className="h-3 w-3" /> Sign in
              </Button>
            )}
            {a.manageable && a.report?.status?.signedIn && (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy === `out-${a.id}`}
                onClick={() => void act(`out-${a.id}`, () => harnessesApi.cliLogout(a.id), "Signed out")}>
                <LogOut className="h-3 w-3" /> Sign out
              </Button>
            )}
            {a.manageable && (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" onClick={() => setRemoving(a)}><Trash2 className="h-3 w-3" /> Remove</Button>
            )}
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="CLI" className={selectClass} value={draft.cli} onChange={(e) => setDraft({ ...draft, cli: e.target.value as CliId })}>
          <option value="claude">{CLI_NAMES.claude}</option>
          <option value="codex">{CLI_NAMES.codex}</option>
        </select>
        <select aria-label="Computer" className={selectClass} value={draft.computer} onChange={(e) => setDraft({ ...draft, computer: e.target.value })}>
          <option value="host">This server</option>
          {computers.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <Input className="h-8 w-48 text-xs" placeholder="Label (e.g. My Max plan)" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} aria-label="Account label" />
        <Button size="sm" className="h-8 text-xs" disabled={busy === "add"} onClick={() => void act("add", async () => {
          const a = await harnessesApi.addCliAccount({ cli: draft.cli, computer: draft.computer, ...(draft.label.trim() ? { label: draft.label.trim() } : {}) });
          setDraft({ ...draft, label: "" });
          const fresh = await harnessesApi.cliAccounts();
          setData(fresh);
          const view = (fresh.accounts ?? []).find((x) => x.id === a.id);
          if (view?.manageable) setSignIn(view);
        }, "Account added: sign in to use it")} data-testid="cli-account-add">
          {busy === "add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add account
        </Button>
      </div>

      {data && (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!data.allowInstanceCodex} aria-label="Allow instance Codex accounts"
            onChange={(e) => void act("instance", () => harnessesApi.setCliSettings({ allowInstanceCodex: e.target.checked }))} />
          Codex accounts owned by the instance may run any of its work (a shared ChatGPT plan: check OpenAI's terms first)
        </label>
      )}

      <CliSignInDialog account={signIn} onClose={() => { setSignIn(null); void load(); }} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => { if (!open) setRemoving(null); }}
        title="Remove this CLI account?"
        description="Polpo forgets it. Its sign-in stays in its directory on the computer until you sign out (Sign out first to end it)."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await act(`rm-${removing.id}`, () => harnessesApi.removeCliAccount(removing.id), "Account removed");
          setRemoving(null);
        }}
      />
    </CardContent></Card>
  );
}
