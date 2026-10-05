/**
 * RuleFormDialog — add/edit a notification rule.
 *
 * The rule is persisted as part of `settings.notifications.rules` in
 * `polpo.json` via `PUT /api/v1/config/rules/:id`.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronDown, ChevronRight, Loader2, X, Plus, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  HOOK_EVENT_CATALOG,
  HOOK_EVENT_GLOBS,
  getHookEventDef,
  isCanonicalHookEvent,
  type HookEventDef,
} from "@polpo-ai/core/hook-events";
import { summarizeRule } from "@/lib/rule-summary";

// ── Types ────────────────────────────────────────────────────────────

export interface NotificationRuleDraft {
  id: string;
  name?: string;
  events: string[];
  channels: string[];
  severity?: "info" | "warning" | "error" | "critical";
  template?: string;
  condition?: Record<string, unknown>;
  cooldownMs?: number;
  includeOutcomes?: boolean;
  outcomeFilter?: { types?: string[]; tags?: string[] };
  maxAttachmentSize?: number;
  actions?: Array<Record<string, unknown>>;
}

interface RuleFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Initial rule (for edit). When undefined, the form is in create mode. */
  initial?: NotificationRuleDraft;
  /** All currently configured channel names. */
  channels: string[];
  /** All existing rule ids — used to validate uniqueness on create. */
  existingIds: string[];
  /** Persist the rule. Throw on failure to keep dialog open. */
  onSave: (rule: NotificationRuleDraft) => Promise<void>;
}

// ── Constants ────────────────────────────────────────────────────────

/**
 * High-signal events surfaced first when the search input is empty.
 * These are the ones humans actually want to subscribe to 90% of the time —
 * not the noisy ones (tick, activity) and not the redundant ones (transition
 * + created + updated all overlap heavily).
 */
const DEFAULT_SUGGESTED_EVENT_NAMES = new Set<string>([
  "task:maxRetries",
  "task:timeout",
  "task:question",
  "mission:completed",
  "schedule:triggered",
  "approval:requested",
  "sla:violated",
  "quality:gate:failed",
  "escalation:human",
  "orchestrator:deadlock",
]);

const OUTCOME_TYPES: string[] = ["file", "text", "url", "json", "media"];

/** Rich suggestion row — either a catalog event or a glob shortcut. */
interface EventSuggestion {
  name: string;
  label: string;
  description: string;
  isGlob?: boolean;
}

/** Build the suggestion pool once (catalog + globs). Stable identity. */
const ALL_SUGGESTIONS: EventSuggestion[] = [
  ...HOOK_EVENT_CATALOG.map((e: HookEventDef): EventSuggestion => ({
    name: e.name,
    label: e.label,
    description: e.description,
  })),
  ...HOOK_EVENT_GLOBS.map((g): EventSuggestion => ({
    name: g.pattern,
    label: g.label,
    description: g.description,
    isGlob: true,
  })),
];

/**
 * Build the union of allowed top-level payload keys across `events`.
 * Used to warn about typos in {{placeholder}} tokens — if the user types
 * {{task}} but none of the selected events emit a `task` key, we flag it.
 */
function availablePlaceholdersForEvents(events: string[]): Set<string> {
  const set = new Set<string>();
  for (const ev of events) {
    const def = getHookEventDef(ev);
    if (def) {
      for (const p of def.placeholders) set.add(p);
    }
  }
  // Always-available context keys injected by the router.
  set.add("event");
  set.add("severity");
  set.add("data");
  return set;
}

/**
 * Extract top-level {{placeholder}} tokens from a template string.
 * "{{task.title}} failed: {{error}}" → ["task", "error"].
 * Dotted paths only return their leading segment (the top-level key).
 */
function extractTemplatePlaceholders(template: string): string[] {
  const out = new Set<string>();
  const re = /\{\{\s*([a-zA-Z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    out.add(m[1]);
  }
  return [...out];
}

// ── Helpers ──────────────────────────────────────────────────────────

type CooldownUnit = "sec" | "min" | "hour";

function splitCooldownMs(ms?: number): { value: string; unit: CooldownUnit } {
  if (!ms || ms <= 0) return { value: "", unit: "min" };
  if (ms % 3_600_000 === 0) return { value: String(ms / 3_600_000), unit: "hour" };
  if (ms % 60_000 === 0) return { value: String(ms / 60_000), unit: "min" };
  return { value: String(Math.round(ms / 1000)), unit: "sec" };
}

function joinCooldownMs(value: string, unit: CooldownUnit): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const factor = unit === "sec" ? 1000 : unit === "min" ? 60_000 : 3_600_000;
  return Math.round(n * factor);
}

function emptyDraft(): NotificationRuleDraft {
  return { id: "", events: [], channels: [], severity: "info" };
}

// ── Component ────────────────────────────────────────────────────────

export function RuleFormDialog({
  open,
  onOpenChange,
  initial,
  channels,
  existingIds,
  onSave,
}: RuleFormDialogProps) {
  const isEdit = !!initial;
  const [draft, setDraft] = useState<NotificationRuleDraft>(initial ?? emptyDraft());
  const [eventInput, setEventInput] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [conditionText, setConditionText] = useState<string>(
    initial?.condition ? JSON.stringify(initial.condition, null, 2) : "",
  );
  const [cooldown, setCooldown] = useState<{ value: string; unit: CooldownUnit }>(
    splitCooldownMs(initial?.cooldownMs),
  );
  const [filteringOpen, setFilteringOpen] = useState(
    !!(initial?.condition || (initial?.cooldownMs && initial.cooldownMs > 0)),
  );
  const [outcomesOpen, setOutcomesOpen] = useState(!!initial?.includeOutcomes);
  const [templateOpen, setTemplateOpen] = useState(!!initial?.template);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reset state every time we open with a different `initial`.
  useEffect(() => {
    if (!open) return;
    setDraft(initial ?? emptyDraft());
    setEventInput("");
    setTagInput("");
    setConditionText(initial?.condition ? JSON.stringify(initial.condition, null, 2) : "");
    setCooldown(splitCooldownMs(initial?.cooldownMs));
    setFilteringOpen(!!(initial?.condition || (initial?.cooldownMs && initial.cooldownMs > 0)));
    setOutcomesOpen(!!initial?.includeOutcomes);
    setTemplateOpen(!!initial?.template);
    setErrors({});
    setSaveError(null);
  }, [open, initial]);

  const eventSuggestions = useMemo<EventSuggestion[]>(() => {
    const q = eventInput.trim().toLowerCase();
    const taken = new Set(draft.events);
    if (!q) {
      // Default: show the curated high-signal subset + the glob shortcuts.
      const high = ALL_SUGGESTIONS.filter(
        s => !taken.has(s.name) && (s.isGlob || DEFAULT_SUGGESTED_EVENT_NAMES.has(s.name)),
      );
      return high.slice(0, 12);
    }
    return ALL_SUGGESTIONS.filter(
      s =>
        !taken.has(s.name)
        && (
          s.name.toLowerCase().includes(q)
          || s.label.toLowerCase().includes(q)
          || s.description.toLowerCase().includes(q)
        ),
    ).slice(0, 14);
  }, [eventInput, draft.events]);

  // ── Live warnings (non-blocking) ──
  const warnings = useMemo(() => {
    const unknownEvents = draft.events.filter(e => !isCanonicalHookEvent(e));
    const allowed = availablePlaceholdersForEvents(draft.events);
    const unknownPlaceholders: string[] = [];
    if (draft.template) {
      for (const p of extractTemplatePlaceholders(draft.template)) {
        if (!allowed.has(p)) unknownPlaceholders.push(p);
      }
    }
    return { events: unknownEvents, placeholders: unknownPlaceholders };
  }, [draft.events, draft.template]);

  // Catalog-driven placeholder chips for the currently selected events.
  const availablePlaceholderList = useMemo(
    () => [...availablePlaceholdersForEvents(draft.events)].sort(),
    [draft.events],
  );

  const addEvent = (value: string) => {
    const v = value.trim();
    if (!v) return;
    if (draft.events.includes(v)) return;
    setDraft((d) => ({ ...d, events: [...d.events, v] }));
    setEventInput("");
  };

  const removeEvent = (value: string) => {
    setDraft((d) => ({ ...d, events: d.events.filter((e) => e !== value) }));
  };

  const toggleChannel = (name: string) => {
    setDraft((d) =>
      d.channels.includes(name)
        ? { ...d, channels: d.channels.filter((c) => c !== name) }
        : { ...d, channels: [...d.channels, name] },
    );
  };

  const toggleOutcomeType = (type: string) => {
    setDraft((d) => {
      const current = d.outcomeFilter?.types ?? [];
      const next = current.includes(type)
        ? current.filter((t) => t !== type)
        : [...current, type];
      return { ...d, outcomeFilter: { ...d.outcomeFilter, types: next } };
    });
  };

  const addTag = () => {
    const v = tagInput.trim();
    if (!v) return;
    setDraft((d) => {
      const current = d.outcomeFilter?.tags ?? [];
      if (current.includes(v)) return d;
      return { ...d, outcomeFilter: { ...d.outcomeFilter, tags: [...current, v] } };
    });
    setTagInput("");
  };

  const removeTag = (tag: string) => {
    setDraft((d) => {
      const current = d.outcomeFilter?.tags ?? [];
      return { ...d, outcomeFilter: { ...d.outcomeFilter, tags: current.filter((t) => t !== tag) } };
    });
  };

  // ── Validation ──

  const validate = (): { ok: boolean; condition?: Record<string, unknown> } => {
    const errs: Record<string, string> = {};
    const id = draft.id.trim();
    if (!id) errs.id = "ID is required";
    else if (!/^[a-zA-Z0-9_:-]+$/.test(id))
      errs.id = "ID must be alphanumeric (dashes, underscores, colons allowed)";
    else if (!isEdit && existingIds.includes(id)) errs.id = "ID already exists";

    if (draft.events.length === 0) errs.events = "At least one event is required";
    if (draft.channels.length === 0) errs.channels = "At least one channel is required";

    let parsedCondition: Record<string, unknown> | undefined;
    if (conditionText.trim()) {
      try {
        const parsed = JSON.parse(conditionText);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          errs.condition = "Condition must be a JSON object";
        } else {
          parsedCondition = parsed as Record<string, unknown>;
        }
      } catch (e) {
        errs.condition = `Invalid JSON: ${(e as Error).message}`;
      }
    }

    if (cooldown.value.trim()) {
      const ms = joinCooldownMs(cooldown.value, cooldown.unit);
      if (ms === undefined) errs.cooldown = "Cooldown must be a positive number";
    }

    if (
      draft.maxAttachmentSize !== undefined &&
      (!Number.isFinite(draft.maxAttachmentSize) || draft.maxAttachmentSize < 0)
    ) {
      errs.maxAttachmentSize = "Must be a non-negative number";
    }

    setErrors(errs);
    return { ok: Object.keys(errs).length === 0, condition: parsedCondition };
  };

  const handleSave = async () => {
    const v = validate();
    if (!v.ok) return;

    const cooldownMs = cooldown.value.trim()
      ? joinCooldownMs(cooldown.value, cooldown.unit)
      : undefined;

    const rule: NotificationRuleDraft = {
      id: draft.id.trim(),
      name: draft.name?.trim() || draft.id.trim(),
      events: draft.events,
      channels: draft.channels,
      severity: draft.severity,
      template: templateOpen && draft.template?.trim() ? draft.template : undefined,
      condition: v.condition,
      cooldownMs,
      includeOutcomes: outcomesOpen ? !!draft.includeOutcomes : undefined,
      outcomeFilter:
        outcomesOpen && draft.includeOutcomes
          ? {
              types: draft.outcomeFilter?.types?.length ? draft.outcomeFilter.types : undefined,
              tags: draft.outcomeFilter?.tags?.length ? draft.outcomeFilter.tags : undefined,
            }
          : undefined,
      maxAttachmentSize:
        outcomesOpen && draft.includeOutcomes ? draft.maxAttachmentSize : undefined,
      actions: draft.actions,
    };

    setSaving(true);
    setSaveError(null);
    try {
      await onSave(rule);
      onOpenChange(false);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-3 shrink-0">
          <DialogTitle>{isEdit ? "Edit notification rule" : "New notification rule"}</DialogTitle>
          <DialogDescription>
            Trigger notifications when lifecycle events match. Saved to{" "}
            <code className="text-[11px] font-mono">.polpo/polpo.json</code>.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-6 pb-2 space-y-5">
            {/* Live summary — always visible, top of the form */}
            <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-primary/80 mb-1">
                Summary
              </p>
              <p className="text-xs leading-relaxed">{summarizeRule(draft as unknown as Parameters<typeof summarizeRule>[0])}</p>
            </div>

            {/* Section 1 — Identity */}
            <Section title="Identity">
              <Field label="ID" error={errors.id} required>
                <Input
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  placeholder="rule-task-failures"
                  className="font-mono text-xs"
                  disabled={isEdit}
                />
              </Field>
              <Field label="Name (optional)">
                <Input
                  value={draft.name ?? ""}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Human-readable label"
                />
              </Field>
              <Field label="Severity">
                <Select
                  value={draft.severity ?? "info"}
                  onValueChange={(v) =>
                    setDraft({ ...draft, severity: v as NotificationRuleDraft["severity"] })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="info">info</SelectItem>
                    <SelectItem value="warning">warning</SelectItem>
                    <SelectItem value="error">error</SelectItem>
                    <SelectItem value="critical">critical</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </Section>

            {/* Section 2 — Events */}
            <Section title="When (events)" description="Lifecycle hooks or glob patterns to match.">
              {/* Selected events — card-style rows with label, desc, glob badge */}
              <div className="space-y-1.5 mb-2">
                {draft.events.map((e) => {
                  const def = getHookEventDef(e);
                  const glob = HOOK_EVENT_GLOBS.find(g => g.pattern === e);
                  const canonical = isCanonicalHookEvent(e);
                  const label = def?.label ?? glob?.label ?? "Custom pattern";
                  const desc = def?.description ?? glob?.description ?? "User-typed event pattern.";
                  return (
                    <div
                      key={e}
                      className={cn(
                        "flex items-start gap-2 rounded-md border px-2.5 py-1.5",
                        canonical
                          ? "border-border/40 bg-muted/15"
                          : "border-amber-500/40 bg-amber-500/5",
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <code className="text-[11px] font-mono font-medium">{e}</code>
                          <span className="text-[10px] text-muted-foreground">·</span>
                          <span className="text-[11px] font-medium">{label}</span>
                          {glob && (
                            <Badge variant="outline" className="text-[9px] h-4 px-1">glob</Badge>
                          )}
                          {!canonical && (
                            <span
                              className="inline-flex items-center gap-0.5 text-[10px] text-amber-600"
                              title="This event name is not in the canonical catalog. Save still works, but it may never fire."
                            >
                              <AlertTriangle className="h-2.5 w-2.5" /> unknown
                            </span>
                          )}
                        </div>
                        <p className="text-[10.5px] text-muted-foreground leading-snug mt-0.5">{desc}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeEvent(e)}
                        className="text-muted-foreground hover:text-destructive cursor-pointer shrink-0"
                        aria-label={`Remove ${e}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
                {draft.events.length === 0 && (
                  <span className="text-[11px] text-muted-foreground italic">No events yet — pick from suggestions below.</span>
                )}
              </div>

              <div className="flex gap-2">
                <Input
                  value={eventInput}
                  onChange={(e) => setEventInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addEvent(eventInput);
                    }
                  }}
                  placeholder="Search by name, label, or description... (Enter to add custom)"
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => addEvent(eventInput)}
                  disabled={!eventInput.trim()}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>

              {eventSuggestions.length > 0 && (
                <div className="border border-border/30 rounded-md max-h-56 overflow-y-auto mt-2 divide-y divide-border/20">
                  {eventSuggestions.map((s) => (
                    <button
                      key={s.name}
                      type="button"
                      onClick={() => addEvent(s.name)}
                      className="w-full flex items-start gap-2 text-left px-2.5 py-1.5 hover:bg-accent cursor-pointer"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <code className="text-[11px] font-mono font-medium">{s.name}</code>
                          <span className="text-[10px] text-muted-foreground">·</span>
                          <span className="text-[11px] font-medium">{s.label}</span>
                          {s.isGlob && (
                            <Badge variant="outline" className="text-[9px] h-4 px-1">glob</Badge>
                          )}
                        </div>
                        <p className="text-[10.5px] text-muted-foreground leading-snug mt-0.5">{s.description}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Non-blocking warnings */}
              {warnings.events.length > 0 && (
                <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5">
                  <AlertTriangle className="h-3 w-3 text-amber-600 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-amber-700 leading-snug">
                    {warnings.events.length === 1 ? "1 event is" : `${warnings.events.length} events are`}{" "}
                    not in the canonical catalog: {warnings.events.map(e => <code key={e} className="font-mono mr-1">{e}</code>)}.
                    The rule will save, but unknown events may never fire.
                  </p>
                </div>
              )}

              {errors.events && <p className="text-[11px] text-destructive mt-1">{errors.events}</p>}
            </Section>

            {/* Section 3 — Channels */}
            <Section
              title="Where (channels)"
              description="Which configured channels receive this notification."
            >
              {channels.length === 0 ? (
                <p className="text-[11px] text-muted-foreground italic">
                  No channels configured. Add one in the Channels tab first.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-1.5">
                  {channels.map((c) => {
                    const selected = draft.channels.includes(c);
                    return (
                      <button
                        type="button"
                        key={c}
                        onClick={() => toggleChannel(c)}
                        className={cn(
                          "flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors cursor-pointer",
                          selected
                            ? "bg-accent border-primary/30 text-accent-foreground"
                            : "border-border/40 hover:bg-muted",
                        )}
                      >
                        <div
                          className={cn(
                            "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                            selected ? "bg-primary border-primary" : "border-muted-foreground/40",
                          )}
                        >
                          {selected && (
                            <span className="text-[8px] text-primary-foreground">✓</span>
                          )}
                        </div>
                        <span className="truncate font-mono">{c}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {errors.channels && (
                <p className="text-[11px] text-destructive mt-1">{errors.channels}</p>
              )}
            </Section>

            {/* Section 4 — Filtering */}
            <CollapsibleSection
              open={filteringOpen}
              onOpenChange={setFilteringOpen}
              title="Filtering (optional)"
            >
              <Field
                label="Condition (JSON object)"
                description="Map of payload paths to expected values, e.g. { &quot;task.priority&quot;: &quot;high&quot; }"
                error={errors.condition}
              >
                <Textarea
                  value={conditionText}
                  onChange={(e) => setConditionText(e.target.value)}
                  placeholder='{ "task.priority": "high" }'
                  className="font-mono text-xs min-h-20"
                />
              </Field>
              <Field label="Cooldown" error={errors.cooldown}>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    min="0"
                    value={cooldown.value}
                    onChange={(e) => setCooldown({ ...cooldown, value: e.target.value })}
                    placeholder="0"
                    className="flex-1"
                  />
                  <Select
                    value={cooldown.unit}
                    onValueChange={(v) => setCooldown({ ...cooldown, unit: v as CooldownUnit })}
                  >
                    <SelectTrigger className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sec">seconds</SelectItem>
                      <SelectItem value="min">minutes</SelectItem>
                      <SelectItem value="hour">hours</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </Field>
            </CollapsibleSection>

            {/* Section 5 — Outcomes */}
            <CollapsibleSection
              open={outcomesOpen}
              onOpenChange={setOutcomesOpen}
              title="Outcomes (optional)"
            >
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!draft.includeOutcomes}
                  onChange={(e) => setDraft({ ...draft, includeOutcomes: e.target.checked })}
                  className="h-3.5 w-3.5 cursor-pointer"
                />
                <span className="text-xs">Include task outcomes as attachments</span>
              </label>
              {draft.includeOutcomes && (
                <div className="space-y-3 mt-2 pl-5">
                  <Field label="Outcome types">
                    <div className="flex flex-wrap gap-1.5">
                      {OUTCOME_TYPES.map((t) => {
                        const selected = draft.outcomeFilter?.types?.includes(t) ?? false;
                        return (
                          <button
                            type="button"
                            key={t}
                            onClick={() => toggleOutcomeType(t)}
                            className={cn(
                              "text-[10px] font-mono rounded-md border px-2 py-1 transition-colors cursor-pointer",
                              selected
                                ? "bg-primary text-primary-foreground border-primary"
                                : "border-border/40 hover:bg-muted",
                            )}
                          >
                            {t}
                          </button>
                        );
                      })}
                    </div>
                  </Field>
                  <Field label="Tags">
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {(draft.outcomeFilter?.tags ?? []).map((t) => (
                        <Badge key={t} variant="secondary" className="text-[10px] gap-1">
                          {t}
                          <button
                            type="button"
                            onClick={() => removeTag(t)}
                            className="hover:text-destructive cursor-pointer"
                            aria-label={`Remove tag ${t}`}
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Input
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addTag();
                          }
                        }}
                        placeholder="tag (Enter to add)"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addTag}
                        disabled={!tagInput.trim()}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </Field>
                  <Field label="Max attachment size (KB)" error={errors.maxAttachmentSize}>
                    <Input
                      type="number"
                      min="0"
                      value={
                        draft.maxAttachmentSize != null
                          ? String(Math.round(draft.maxAttachmentSize / 1024))
                          : ""
                      }
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        setDraft({
                          ...draft,
                          maxAttachmentSize: e.target.value === "" || !Number.isFinite(n)
                            ? undefined
                            : n * 1024,
                        });
                      }}
                      placeholder="e.g. 1024"
                    />
                  </Field>
                </div>
              )}
            </CollapsibleSection>

            {/* Section 6 — Template */}
            <CollapsibleSection
              open={templateOpen}
              onOpenChange={setTemplateOpen}
              title="Template (optional)"
            >
              <Field
                label="Message template"
                description="Use {{variable}} placeholders. Leave empty for default."
              >
                <Textarea
                  value={draft.template ?? ""}
                  onChange={(e) => setDraft({ ...draft, template: e.target.value })}
                  placeholder="Task {{task.title}} failed: {{error}}"
                  className="font-mono text-xs min-h-16"
                />
              </Field>
              {availablePlaceholderList.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Placeholders available for selected events
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {availablePlaceholderList.map(p => (
                      <code
                        key={p}
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted/30 border border-border/30"
                      >
                        {`{{${p}}}`}
                      </code>
                    ))}
                  </div>
                </div>
              )}
              {warnings.placeholders.length > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5">
                  <AlertTriangle className="h-3 w-3 text-amber-600 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-amber-700 leading-snug">
                    Template references {warnings.placeholders.length === 1 ? "a placeholder" : "placeholders"} not emitted by the selected events:{" "}
                    {warnings.placeholders.map(p => <code key={p} className="font-mono mr-1">{`{{${p}}}`}</code>)}.
                    They will render as empty strings.
                  </p>
                </div>
              )}
            </CollapsibleSection>

            {saveError && (
              <div className="text-[11px] text-destructive bg-destructive/10 border border-destructive/30 rounded px-2 py-1.5">
                {saveError}
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="px-6 py-4 border-t shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Local UI helpers ─────────────────────────────────────────────────

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h4>
        {description && (
          <p className="text-[11px] text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

function CollapsibleSection({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground cursor-pointer">
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2 space-y-2.5">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function Field({
  label,
  description,
  error,
  required,
  children,
}: {
  label: string;
  description?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
        {label}
        {required && <span className="text-destructive">*</span>}
      </label>
      {children}
      {description && !error && (
        <p className="text-[10px] text-muted-foreground">{description}</p>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
