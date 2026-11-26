/**
 * "Generate cases" (docs/agent-suites.md, "AI case generation"): the suite's generator (Polpo, an agent, or a model and engine) proposes cases from
 * the agent's instructions, tools, skills and connectors (and a brief) — happy paths, edge cases and
 * adversarial / prompt-injection ones — or dataset rows for a case. Nothing is saved until the
 * person ticks the proposals to keep and adds them. Also: a case from a real chat or task run
 * (its exchange recorded as a cassette).
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, MessagesSquare, Sparkles, Table2 } from "lucide-react";
import type { AgentSuite, GeneratedCaseProposal, SuiteRole, UseAgentSuitesReturn } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SuiteRolePicker } from "./suite-role-picker";
import { describeRole } from "@/lib/suite-roles";

type Mode = "cases" | "rows" | "record";
const KINDS = [["happy", "Happy paths"], ["edge", "Edge cases"], ["adversarial", "Adversarial / prompt injection"]] as const;

export function AgentSuiteGenerateDialog({ open, onOpenChange, suites, initialMode = "cases", initialSuite }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suites: Pick<UseAgentSuitesReturn, "suites" | "generate" | "accept" | "generateRows" | "importDataset" | "fromRecording">;
  initialMode?: Mode;
  initialSuite?: string;
}) {
  const list = useMemo(() => suites.suites ?? [], [suites.suites]);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [suiteId, setSuiteId] = useState(initialSuite ?? list[0]?.id ?? "");
  const [brief, setBrief] = useState("");
  const [samples, setSamples] = useState("");
  const [count, setCount] = useState(6);
  const [include, setInclude] = useState<Set<string>>(new Set(KINDS.map(([k]) => k)));
  const [style, setStyle] = useState<"contract" | "tools">("contract");
  const [busy, setBusy] = useState(false);
  const [proposals, setProposals] = useState<GeneratedCaseProposal[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [rowsCase, setRowsCase] = useState("");
  const [rows, setRows] = useState<{ datasetId?: string; columns: string[]; rows: Array<Record<string, unknown>> } | null>(null);
  const [source, setSource] = useState<"session" | "task">("session");
  const [sourceId, setSourceId] = useState("");
  const [caseName, setCaseName] = useState("");
  /** Who writes them this time (default the suite's generator, else Polpo). */
  const [generator, setGenerator] = useState<SuiteRole | undefined>(undefined);
  const suite: AgentSuite | undefined = useMemo(() => list.find((s) => s.id === suiteId), [list, suiteId]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const generate = () => act(async () => {
    const sessionIds = samples.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean).slice(0, 5);
    const out = await suites.generate({
      ...(suiteId ? { suiteId } : {}), count, ...(brief.trim() ? { brief: brief.trim() } : {}), ...(sessionIds.length ? { sessionIds } : {}),
      include: [...include] as Array<"happy" | "edge" | "adversarial">, style, ...(generator ? { generator } : {}),
    });
    setProposals(out.proposals);
    setPicked(new Set());
  });
  const accept = () => act(async () => {
    const chosen = (proposals ?? []).filter((p) => picked.has(p.index) && p.case);
    if (!suiteId || !chosen.length) return;
    await suites.accept(suiteId, chosen.map((p) => p.case!), chosen.flatMap((p) => (p.dataset ? [p.dataset] : [])));
    toast.success(`Added ${chosen.length} case(s) to ${suite?.name ?? suiteId}`);
    setProposals(null);
    onOpenChange(false);
  });
  const generateRows = () => act(async () => { setRows(await suites.generateRows(suiteId, { caseId: rowsCase, count, ...(generator ? { generator } : {}) })); });
  const addRows = () => act(async () => {
    if (!rows?.datasetId) return;
    await suites.importDataset(suiteId, { format: "json", id: rows.datasetId, mode: "append", text: JSON.stringify(rows.rows) });
    toast.success(`Added ${rows.rows.length} row(s)`);
    setRows(null);
  });
  const record = () => act(async () => {
    const out = await suites.fromRecording(suiteId, { ...(source === "session" ? { sessionId: sourceId.trim() } : { taskId: sourceId.trim() }), ...(caseName.trim() ? { name: caseName.trim() } : {}) });
    toast.success(`Added ${out.case.name}: it replays the recorded exchange offline`);
    onOpenChange(false);
  });
  const rowsCaseObj = suite?.cases.find((c) => c.id === rowsCase);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="suite-generate-dialog">
        <DialogHeader>
          <DialogTitle>Add cases</DialogTitle>
          <DialogDescription>Proposals from the generator (Polpo, an agent, or a model and engine) are never saved by themselves: tick the ones to keep. A real chat or task becomes a case that replays it.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          {([["cases", "Generate cases", Sparkles], ["rows", "Dataset rows", Table2], ["record", "From a chat or task", MessagesSquare]] as const).map(([m, label, Icon]) => (
            <Button key={m} size="sm" variant={mode === m ? "secondary" : "outline"} aria-pressed={mode === m} onClick={() => setMode(m)} data-testid={`suite-generate-mode-${m}`}>
              <Icon className="mr-1 h-3.5 w-3.5" /> {label}
            </Button>
          ))}
        </div>
        <div className="space-y-1">
          <span className="text-xs font-medium">Suite</span>
          <Select value={suiteId} onValueChange={(v) => { setSuiteId(v); setRowsCase(""); setRows(null); }}>
            <SelectTrigger size="sm" aria-label="Suite" data-testid="suite-generate-suite"><SelectValue placeholder="Choose a suite" /></SelectTrigger>
            <SelectContent>{list.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {mode !== "record" && (
          <SuiteRolePicker label="Who writes them" value={generator} onChange={setGenerator} testId="suite-generate-generator"
            inheritLabel={`The suite's generator (${describeRole(suite?.generator)})`} />
        )}

        {mode === "cases" && (
          <div className="space-y-3">
            <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={2} placeholder="What to focus on (optional): e.g. refunds over 100 EUR, Italian customers" aria-label="Brief" />
            <Input value={samples} onChange={(e) => setSamples(e.target.value)} placeholder="Sample chats to draw from (optional): up to 5 chat session ids, comma separated" className="h-8 text-caption" aria-label="Sample chats" data-testid="suite-generate-samples" />
            <p className="text-caption text-muted-foreground">The generator reads the agent's instructions, tools, skills and connectors. Adversarial cases try prompt injection, off-scope requests and unsafe actions.</p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs">Cases <Input type="number" min={1} max={20} value={count} onChange={(e) => setCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} className="h-7 w-16" aria-label="How many cases" /></label>
              {KINDS.map(([k, label]) => (
                <label key={k} className="flex items-center gap-1.5 text-xs">
                  <Checkbox checked={include.has(k)} onCheckedChange={(v) => setInclude((s) => { const n = new Set(s); if (v) n.add(k); else n.delete(k); return n; })} aria-label={label} />{label}
                </label>
              ))}
              <Select value={style} onValueChange={(v) => setStyle(v as "contract" | "tools")}>
                <SelectTrigger size="sm" className="w-48" aria-label="Style"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="contract">Offline (scripted model)</SelectItem>
                  <SelectItem value="tools">Real model, mocked tools</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" disabled={busy || !include.size} onClick={() => void generate()} data-testid="suite-generate-run">
                {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />} Generate
              </Button>
            </div>
            {proposals && (
              <ul className="divide-y divide-border/40 rounded-control border border-border/40" data-testid="suite-proposals">
                {proposals.map((p) => (
                  <li key={p.index} className={cn("flex items-start gap-3 px-3 py-2", !p.case && "opacity-70")} data-testid="suite-proposal" data-valid={!!p.case}>
                    <Checkbox className="mt-0.5" disabled={!p.case} checked={picked.has(p.index)} aria-label={`Keep ${p.case?.name ?? `proposal ${p.index}`}`}
                      onCheckedChange={(v) => setPicked((s) => { const n = new Set(s); if (v) n.add(p.index); else n.delete(p.index); return n; })} />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
                        {p.case?.name ?? `Proposal ${p.index}`}
                        {p.category && <Badge variant="outline" className={cn("text-micro", p.category === "adversarial" && "border-warning/40 text-warning")}>{p.category}</Badge>}
                      </p>
                      {p.case ? (
                        <>
                          <p className="text-caption text-muted-foreground">“{p.case.input.message.slice(0, 200)}” · {p.case.assertions.length} assertion(s){p.case.scorers?.length ? `, ${p.case.scorers.length} scorer(s)` : ""}{p.dataset ? `, ${p.dataset.rows.length} row(s)` : ""} · {p.case.mode ?? "suite mode"}</p>
                          {p.rationale && <p className="text-caption text-muted-foreground">{p.rationale}</p>}
                        </>
                      ) : <p className="text-caption text-destructive">Invalid: {p.error}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {mode === "rows" && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Select value={rowsCase} onValueChange={(v) => { setRowsCase(v); setRows(null); }}>
                <SelectTrigger size="sm" className="w-56" aria-label="Case"><SelectValue placeholder="Choose a case" /></SelectTrigger>
                <SelectContent>{(suite?.cases ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}{c.dataset ? ` (${c.dataset})` : ""}</SelectItem>)}</SelectContent>
              </Select>
              <label className="flex items-center gap-1.5 text-xs">Rows <Input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} className="h-7 w-16" aria-label="How many rows" /></label>
              <Button size="sm" disabled={busy || !rowsCase} onClick={() => void generateRows()} data-testid="suite-generate-rows">
                {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />} Propose rows
              </Button>
            </div>
            {rowsCaseObj && !rowsCaseObj.dataset && <p className="text-caption text-muted-foreground">This case has no dataset yet: give it one in the editor (Datasets), then propose rows for it.</p>}
            {rows && (
              <div className="overflow-x-auto rounded-control border border-border/40">
                <table className="w-full text-caption" data-testid="suite-proposed-rows">
                  <thead><tr className="text-left text-muted-foreground">{rows.columns.map((c) => <th key={c} className="px-2 py-1 font-medium">{c}</th>)}</tr></thead>
                  <tbody>{rows.rows.map((r, i) => <tr key={i} className="border-t border-border/30">{rows.columns.map((c) => <td key={c} className="px-2 py-1 font-mono">{String(r[c] ?? "")}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {mode === "record" && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Select value={source} onValueChange={(v) => setSource(v as "session" | "task")}>
                <SelectTrigger size="sm" className="w-40" aria-label="Source"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="session">A chat (session id)</SelectItem><SelectItem value="task">A task run (task id)</SelectItem></SelectContent>
              </Select>
              <Input value={sourceId} onChange={(e) => setSourceId(e.target.value)} placeholder={source === "session" ? "Chat session id" : "Task id"} className="h-8 w-56" aria-label="Session or task id" data-testid="suite-record-source" />
              <Input value={caseName} onChange={(e) => setCaseName(e.target.value)} placeholder="Case name (optional)" className="h-8 w-48" aria-label="Case name" />
            </div>
            <p className="text-caption text-muted-foreground">The exchange becomes a case and its cassette (secrets redacted): the case replays it offline and checks the same tool calls in order.</p>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          {mode === "cases" && <Button disabled={busy || !suiteId || !picked.size} onClick={() => void accept()} data-testid="suite-generate-accept">Add {picked.size || ""} case(s)</Button>}
          {mode === "rows" && <Button disabled={busy || !rows?.datasetId} onClick={() => void addRows()} data-testid="suite-generate-add-rows">Add rows</Button>}
          {mode === "record" && <Button disabled={busy || !suiteId || !sourceId.trim()} onClick={() => void record()} data-testid="suite-record-add">Add the case</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
