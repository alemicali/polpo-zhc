/**
 * AgentEditSheet — edit an agent's configuration from its page: role, team, model,
 * instructions, tools, skills, identity and the advanced settings. Sandbox, pipeline,
 * credentials and learning keep their own tabs.
 */

import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, Loader2, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { useAgents } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ModelPicker } from "@/components/shared/model-picker";
import { useConfiguredProviders } from "@/hooks/use-configured-providers";
import { toolCategories, reasoningMeta } from "@/lib/agent-meta";
import {
  CORE_TOOLS, REASONING_LEVELS, VOICE_REPLIES,
  agentUpdateFrom, formFromAgent, type AgentForm,
} from "@/lib/agent-edit";
import { cn } from "@/lib/utils";
import { useAgentDetail } from "./agent-detail-context";

/** Select needs a non-empty value for "use the default". */
const DEFAULT = "__default";
const CATEGORY_PREFIXES = toolCategories.map((c) => c.prefix);

export function AgentEditSheet({ open, onOpenChange, session }: { open: boolean; onOpenChange: (open: boolean) => void; session: number }) {
  const { state: { agent } } = useAgentDetail();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border/40">
          <SheetTitle>Edit {agent.identity?.displayName ?? agent.name}</SheetTitle>
          <SheetDescription>
            Changes apply to the next tasks and chats of this agent. Sandbox, pipeline, credentials and learning have their own tabs.
          </SheetDescription>
        </SheetHeader>
        {/* A new session on every opening: the form starts from the agent's current settings,
            and stays on screen while the sheet closes. */}
        <AgentEditForm key={`${agent.name}:${session}`} onDone={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}

function AgentEditForm({ onDone }: { onDone: () => void }) {
  const { state: { agent, teamName, skillPool }, actions: { refetch } } = useAgentDetail();
  const { agents, teams, updateAgent } = useAgents();
  const initial = useMemo(() => formFromAgent(agent, teamName, CATEGORY_PREFIXES), [agent, teamName]);
  const [form, setForm] = useState<AgentForm>(initial);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggle = (key: "coreTools" | "categories" | "skills", item: string) =>
    setForm((f) => ({ ...f, [key]: f[key].includes(item) ? f[key].filter((x) => x !== item) : [...f[key], item] }));

  const skillNames = useMemo(
    () => [...new Set([...skillPool.keys(), ...form.skills])].sort(),
    [skillPool, form.skills],
  );
  const missingCore = CORE_TOOLS.filter((t) => !form.coreTools.includes(t));

  const save = async () => {
    const { update, errors: problems } = agentUpdateFrom(initial, form);
    setErrors(problems);
    if (problems.length > 0) return;
    if (Object.keys(update).length === 0) { toast.info("Nothing changed"); onDone(); return; }
    setSaving(true);
    try {
      await updateAgent(agent.name, update);
      await refetch();
      toast.success(`Agent "${agent.name}" saved`);
      onDone();
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        <Section title="General">
          <Row label="Role">
            <Input id="agent-role" value={form.role} onChange={(e) => set("role", e.target.value)} placeholder="e.g. Writes and edits the weekly report" />
          </Row>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Row label="Team">
              <Select value={form.team || undefined} onValueChange={(v) => set("team", v)}>
                <SelectTrigger id="agent-team" className="w-full"><SelectValue placeholder="No team" /></SelectTrigger>
                <SelectContent>
                  {teams.map((t) => <SelectItem key={t.name} value={t.name}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
            <Row label="Reports to">
              <Select value={form.reportsTo || DEFAULT} onValueChange={(v) => set("reportsTo", v === DEFAULT ? "" : v)}>
                <SelectTrigger id="agent-reports-to" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>Nobody</SelectItem>
                  {agents.filter((a) => a.name !== agent.name).map((a) => (
                    <SelectItem key={a.name} value={a.name}>{a.identity?.displayName ?? a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
          </div>
        </Section>

        <Section title="Model">
          <Row label="Model">
            <ModelField value={form.model} onChange={(v) => set("model", v)} />
          </Row>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Row label="Reasoning">
              <Select value={form.reasoning || DEFAULT} onValueChange={(v) => set("reasoning", v === DEFAULT ? "" : v)}>
                <SelectTrigger id="agent-reasoning" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>Project default</SelectItem>
                  {REASONING_LEVELS.map((r) => <SelectItem key={r} value={r}>{reasoningMeta[r]?.label ?? r}</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
            <Row label="Max turns">
              <Input id="agent-max-turns" inputMode="numeric" value={form.maxTurns} onChange={(e) => set("maxTurns", e.target.value)} placeholder="Default" />
            </Row>
            <Row label="Max parallel tasks">
              <Input id="agent-max-concurrency" inputMode="numeric" value={form.maxConcurrency} onChange={(e) => set("maxConcurrency", e.target.value)} placeholder="Unlimited" />
            </Row>
          </div>
        </Section>

        <Section title="Instructions">
          <Row label="Additional instructions" hint="Added to the agent's built-in prompt. Role, identity, tools and skills are added automatically.">
            <Textarea id="agent-system-prompt" rows={8} value={form.systemPrompt} onChange={(e) => set("systemPrompt", e.target.value)} className="font-mono text-xs" />
          </Row>
        </Section>

        <Section title="Tools">
          <Row label="Built-in tools">
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {CORE_TOOLS.map((t) => (
                <Check key={t} id={`tool-${t}`} checked={form.coreTools.includes(t)} onChange={() => toggle("coreTools", t)}>
                  <span className="font-mono text-xs">{t}</span>
                </Check>
              ))}
            </div>
            {missingCore.length > 0 && (
              <p className="text-[11px] text-amber-500">Not available to the agent: {missingCore.join(", ")}.</p>
            )}
          </Row>
          <Row label="Tool categories" hint="Some need credentials in the Credentials tab (email, image, phone…).">
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {toolCategories.map((c) => (
                <Check key={c.prefix} id={`category-${c.prefix}`} checked={form.categories.includes(c.prefix)} onChange={() => toggle("categories", c.prefix)}>
                  <c.icon className={cn("h-3.5 w-3.5 shrink-0", c.color)} />
                  <span className="text-xs">{c.label}</span>
                </Check>
              ))}
            </div>
          </Row>
          <Row label="Other tools" hint="Comma separated: specific tool names or wildcards such as excel_*, pdf_*, docx_*, whatsapp_*.">
            <Input id="agent-other-tools" value={form.otherTools} onChange={(e) => set("otherTools", e.target.value)} className="font-mono text-xs" />
          </Row>
        </Section>

        <Section title="Skills">
          {skillNames.length === 0 ? (
            <p className="text-xs text-muted-foreground">No skills installed. Add them from the Skills page.</p>
          ) : (
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {skillNames.map((s) => (
                <Check key={s} id={`skill-${s}`} checked={form.skills.includes(s)} onChange={() => toggle("skills", s)}>
                  <span className="truncate text-xs" title={skillPool.get(s)?.description}>{s}</span>
                  {!skillPool.has(s) && <span className="text-[10px] text-amber-500">not installed</span>}
                </Check>
              ))}
            </div>
          )}
        </Section>

        <Section title="Identity">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Row label="Display name"><Input id="agent-display-name" value={form.displayName} onChange={(e) => set("displayName", e.target.value)} placeholder={agent.name} /></Row>
            <Row label="Title"><Input id="agent-title" value={form.title} onChange={(e) => set("title", e.target.value)} /></Row>
            <Row label="Company"><Input id="agent-company" value={form.company} onChange={(e) => set("company", e.target.value)} /></Row>
            <Row label="Email"><Input id="agent-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} /></Row>
            <Row label="Timezone"><Input id="agent-timezone" value={form.timezone} onChange={(e) => set("timezone", e.target.value)} placeholder="e.g. Europe/Rome" /></Row>
            <Row label="Tone"><Input id="agent-tone" value={form.tone} onChange={(e) => set("tone", e.target.value)} placeholder="e.g. concise and friendly" /></Row>
          </div>
          <Row label="Personality"><Textarea id="agent-personality" rows={2} value={form.personality} onChange={(e) => set("personality", e.target.value)} /></Row>
          <Row label="Bio"><Textarea id="agent-bio" rows={3} value={form.bio} onChange={(e) => set("bio", e.target.value)} /></Row>
          {form.responsibilities !== null ? (
            <Row label="Responsibilities" hint="One per line.">
              <Textarea id="agent-responsibilities" rows={3} value={form.responsibilities} onChange={(e) => set("responsibilities", e.target.value)} />
            </Row>
          ) : (
            <p className="text-xs text-muted-foreground">Responsibilities have areas and priorities: edit them in the chat with Polpo or in agents.json.</p>
          )}
        </Section>

        <Section title="Advanced">
          <Row label="Allowed folders" hint="One per line, relative to the project. Empty: the project folder.">
            <Textarea id="agent-allowed-paths" rows={2} value={form.allowedPaths} onChange={(e) => set("allowedPaths", e.target.value)} className="font-mono text-xs" />
          </Row>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Row label="Email domains" hint="Comma separated.">
              <Input id="agent-email-domains" value={form.emailAllowedDomains} onChange={(e) => set("emailAllowedDomains", e.target.value)} />
            </Row>
            <Row label="Browser profile">
              <Input id="agent-browser-profile" value={form.browserProfile} onChange={(e) => set("browserProfile", e.target.value)} />
            </Row>
            <Row label="Telegram voice replies">
              <Select value={form.voiceReplies || DEFAULT} onValueChange={(v) => set("voiceReplies", v === DEFAULT ? "" : v)}>
                <SelectTrigger id="agent-voice-replies" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {!initial.voiceReplies && <SelectItem value={DEFAULT}>Default (off)</SelectItem>}
                  {VOICE_REPLIES.map((v) => <SelectItem key={v} value={v}>{v === "voice" ? "To voice messages" : v === "always" ? "Always" : "Off"}</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
          </div>
        </Section>
      </div>

      <SheetFooter className="border-t border-border/40">
        {errors.length > 0 && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="space-y-0.5">{errors.map((e) => <p key={e}>{e}</p>)}</div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onDone} disabled={saving}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Save
          </Button>
        </div>
      </SheetFooter>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-muted-foreground/70">{hint}</span>}
    </div>
  );
}

function Check({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: () => void; children: React.ReactNode }) {
  return (
    <label htmlFor={id} className="flex min-w-0 cursor-pointer items-center gap-2">
      <input id={id} type="checkbox" checked={checked} onChange={onChange} className="h-3.5 w-3.5 shrink-0 accent-primary" />
      {children}
    </label>
  );
}

/** The model picker of the Add agent dialog, with "Use project default". */
function ModelField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const { configuredProviders, providerSources } = useConfiguredProviders();
  return (
    <div className="flex items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id="agent-model" variant="outline" role="combobox" aria-expanded={open} className="flex-1 justify-between font-normal">
            <span className={cn("truncate font-mono text-xs", !value && "font-sans text-muted-foreground")}>{value || "Use project default"}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[320px] p-3" align="start">
          {configuredProviders.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              No authenticated providers. Configure one in Settings → Providers first.
            </div>
          ) : (
            <ModelPicker
              configuredProviders={configuredProviders}
              providerSources={providerSources}
              value={value || null}
              onSelect={(spec) => { onChange(spec); setOpen(false); }}
              maxHeight="280px"
              heading={null}
              subheading={null}
            />
          )}
        </PopoverContent>
      </Popover>
      {value && (
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => onChange("")} aria-label="Use the project default model">
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

/** The Edit button of the agent page, with its sheet. */
export function EditAgentButton({ className, compact }: { className?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  return (
    <>
      <Button variant={compact ? "outline" : "default"} size="sm" className={className} onClick={() => { setSession((n) => n + 1); setOpen(true); }} aria-label="Edit agent">
        <Pencil className={cn("h-3 w-3", !compact && "mr-1.5")} />
        {!compact && "Edit"}
      </Button>
      <AgentEditSheet open={open} onOpenChange={setOpen} session={session} />
    </>
  );
}
