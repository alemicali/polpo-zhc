/**
 * A case's cassette (docs/agent-suites.md, "Record and replay"): the exchange recorded from a live
 * run — every model turn and tool call with its arguments and result, secrets redacted — that the
 * case replays offline. Per call: change the response, delete it, or turn it into a case mock;
 * Record / Re-record runs the case live once more (real model and tools: after a confirmation).
 */
import { useState } from "react";
import { toast } from "sonner";
import { Disc3, Loader2, Pin, RotateCcw, Save, Trash2 } from "lucide-react";
import { useSuiteCassette, type SuiteCassetteCall } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";

function CallRow({ call, busy, onEdit }: { call: SuiteCassetteCall; busy: boolean; onEdit: (edit: { response?: string; delete?: boolean; markAsMock?: boolean }) => Promise<void> }) {
  const [draft, setDraft] = useState(call.response);
  const changed = draft !== call.response;
  return (
    <li className="space-y-1.5 border-b border-border/40 px-4 py-3 last:border-b-0" data-testid="suite-cassette-call" data-call={call.id}>
      <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
        <span className="font-mono font-medium">{call.tool}</span>
        <span className="text-caption text-muted-foreground">turn {call.turn + 1}</span>
        {call.isError && <Badge variant="outline" className="text-micro text-destructive">error</Badge>}
        {call.edited && <Badge variant="outline" className="text-micro">edited</Badge>}
        {call.mock && <Badge variant="outline" className="text-micro text-info" data-testid="suite-cassette-call-mock">case mock</Badge>}
      </p>
      <pre className="max-h-32 overflow-auto rounded-control bg-muted/50 p-2 font-mono text-micro">{JSON.stringify(call.args, null, 2)}</pre>
      <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} className="font-mono text-micro" aria-label={`Response of ${call.tool}`} disabled={call.mock} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" className="h-7" disabled={!changed || busy} onClick={() => void onEdit({ response: draft })} data-testid="suite-cassette-save"><Save className="mr-1 h-3.5 w-3.5" /> Save response</Button>
        {!call.mock && <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => void onEdit({ markAsMock: true })} data-testid="suite-cassette-mark-mock"><Pin className="mr-1 h-3.5 w-3.5" /> Mark as mock</Button>}
        <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => void onEdit({ delete: true })} aria-label={`Delete the ${call.tool} call`} data-testid="suite-cassette-delete-call"><Trash2 className="h-3.5 w-3.5" /></Button>
      </div>
    </li>
  );
}

export function AgentSuiteCassette({ agentName, suiteId, caseId, caseName, onRecord, onClose }: {
  agentName: string;
  suiteId: string;
  caseId: string;
  caseName?: string;
  /** Record (or re-record) the case live: returns the recording run's id. */
  onRecord: (suiteId: string, caseId: string) => Promise<{ id: string }>;
  onClose: () => void;
}) {
  const cas = useSuiteCassette(agentName, suiteId, caseId);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"record" | "delete" | null>(null);
  const c = cas.cassette;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section aria-label="Cassette" className="rounded-lg border border-border/40 bg-card/80" data-testid="suite-cassette">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 px-4 py-3">
        <Disc3 className="h-3.5 w-3.5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">Cassette · {caseName ?? caseId}</p>
          <p className="text-caption text-muted-foreground">
            {c ? `${c.calls.length} call(s), ${c.turns.length} turn(s) · recorded ${new Date(c.recordedAt).toLocaleString()} from ${c.source.kind}${c.recordedBy ? ` by ${c.recordedBy}` : ""} · ${c.redactions} secret value(s) redacted · rev ${c.revision}`
              : c === null ? "Not recorded yet: record runs the case live once (real model and tools), then it replays offline." : "Loading…"}
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm("record")} data-testid="suite-cassette-record">
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1 h-3.5 w-3.5" />}{c ? "Re-record" : "Record"}
        </Button>
        {c && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm("delete")} aria-label="Delete the cassette"><Trash2 className="h-3.5 w-3.5" /></Button>}
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </header>
      {cas.error && <p className="px-4 py-3 text-caption text-destructive">{cas.error.message}</p>}
      {c && (c.calls.length ? (
        <ul>
          {c.calls.map((call) => (
            <CallRow key={`${call.id}:${call.response.length}:${call.mock ? 1 : 0}`} call={call} busy={busy}
              onEdit={(edit) => act(async () => { await cas.edit([{ callId: call.id, ...edit }]); toast.success(edit.markAsMock ? "The call is a mock of the case now" : edit.delete ? "Call deleted" : "Response saved"); })} />
          ))}
        </ul>
      ) : <p className="px-4 py-4 text-center text-caption text-muted-foreground">The recording has no tool calls (only model turns).</p>)}
      {c?.text && <p className="border-t border-border/40 px-4 py-2 text-caption text-muted-foreground">Reply: {c.text.slice(0, 400)}</p>}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => { if (!o) setConfirm(null); }}
        title={confirm === "delete" ? "Delete the cassette?" : c ? "Re-record with real tools?" : "Record with real tools?"}
        description={confirm === "delete"
          ? "The case blocks its tool calls until it is recorded again."
          : "The case runs live once — the agent's real model and real tools: it may send, write or spend (approvals are never given by a test). Its exchange is saved as the cassette, secrets redacted; calls marked as mocks stay pinned."}
        confirmLabel={confirm === "delete" ? "Delete" : c ? "Re-record" : "Record"}
        destructive={confirm === "delete"}
        onConfirm={() => {
          const what = confirm;
          setConfirm(null);
          if (what === "delete") void act(async () => { await cas.remove(); });
          else void act(async () => { const run = await onRecord(suiteId, caseId); toast.success(`Recording (${run.id})`); await cas.refetch(); });
        }}
      />
    </section>
  );
}
