/**
 * Shared fields for creating and editing a group: title, members, settings.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Check, ChevronRight, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { RoomReplyMode, RoomReplyOrder, RoomSettings } from "@/lib/rooms-api";
import { MemberAvatar } from "./group-members";
import type { GroupMember } from "./use-member-directory";

export interface GroupFormValue {
  title: string;
  agents: string[];
  settings: Required<RoomSettings>;
}

const MAX_HOPS_LIMIT = 10;

function Segmented<T extends string>({ value, options, onChange, disabled }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cn("inline-flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5", disabled && "opacity-50")}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "flex h-7 items-center justify-center rounded px-2.5 text-[11px] font-medium transition-colors",
            value === option.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-emerald-500/70" : "bg-muted",
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform",
          checked ? "translate-x-[1.125rem]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function SettingRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-[13px] font-medium leading-tight">{title}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function MemberPicker({ members, selected, onChange, isLoading }: {
  members: GroupMember[];
  selected: string[];
  onChange: (next: string[]) => void;
  isLoading?: boolean;
}) {
  const [query, setQuery] = useState("");
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  // Keep members that are already in the group but no longer configured, so they can be removed.
  const all = useMemo(() => {
    const ids = new Set(members.map((m) => m.id));
    const orphans: GroupMember[] = selected
      .filter((id) => !ids.has(id))
      .map((id) => ({ id, name: id, isOrchestrator: false, known: false }));
    return [...members, ...orphans];
  }, [members, selected]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((m) => `${m.name} ${m.id} ${m.role ?? ""}`.toLowerCase().includes(q));
  }, [all, query]);

  const toggle = (id: string) => {
    onChange(selectedSet.has(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      {all.length > 6 && (
        <div className="relative border-b border-border/60">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents"
            className="h-9 w-full bg-transparent pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}
      <div className="max-h-56 overflow-y-auto p-1">
        {isLoading && members.length <= 1 && (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">Loading agents…</p>
        )}
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">No agents match “{query}”.</p>
        ) : filtered.map((member) => {
          const isSelected = selectedSet.has(member.id);
          return (
            <button
              key={member.id}
              type="button"
              role="checkbox"
              aria-checked={isSelected}
              onClick={() => toggle(member.id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                isSelected ? "bg-primary/10" : "hover:bg-accent/40",
              )}
            >
              <MemberAvatar member={member} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium">{member.name}</span>
                  {member.isOrchestrator && (
                    <span className="shrink-0 rounded-sm border border-border/60 px-1 py-px text-[8px] font-bold uppercase leading-none tracking-[0.12em] text-muted-foreground/70">
                      Orchestrator
                    </span>
                  )}
                  {!member.known && (
                    <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">not configured</span>
                  )}
                </span>
                {(member.role || member.id !== member.name) && (
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {member.role ?? `@${member.id}`}
                  </span>
                )}
              </span>
              <span className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                isSelected ? "border-primary bg-primary text-primary-foreground" : "border-border",
              )}>
                {isSelected && <Check className="h-3 w-3" />}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function GroupSettingsFields({ settings, onChange }: {
  settings: Required<RoomSettings>;
  onChange: (next: Required<RoomSettings>) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const set = <K extends keyof RoomSettings>(key: K, value: Required<RoomSettings>[K]) =>
    onChange({ ...settings, [key]: value });

  return (
    <div className="space-y-4">
      <SettingRow
        title="Who replies"
        description={settings.replyMode === "intent"
          ? "Mentioned agents reply; otherwise the agents the message is meant for."
          : "Only agents you @mention reply."}
      >
        <Segmented<RoomReplyMode>
          value={settings.replyMode}
          onChange={(v) => set("replyMode", v)}
          options={[
            { value: "mentions", label: "Mentions only" },
            { value: "intent", label: "By intent" },
          ]}
        />
      </SettingRow>
      <SettingRow
        title="Reply order"
        description={settings.replyOrder === "parallel"
          ? "Several agents can answer at the same time."
          : "Agents answer one after the other, each seeing the previous reply."}
      >
        <Segmented<RoomReplyOrder>
          value={settings.replyOrder}
          onChange={(v) => set("replyOrder", v)}
          options={[
            { value: "parallel", label: "All at once" },
            { value: "sequential", label: "One after the other" },
          ]}
        />
      </SettingRow>
      <SettingRow title="Agents can answer each other" description="An agent's reply can address another agent in the group.">
        <Switch checked={settings.agentToAgent} onChange={(v) => set("agentToAgent", v)} label="Agents can answer each other" />
      </SettingRow>
      {settings.agentToAgent && (
        <SettingRow title="Max agent turns" description="Agent-to-agent replies allowed after each of your messages.">
          <Input
            type="number"
            min={1}
            max={MAX_HOPS_LIMIT}
            step={1}
            value={settings.maxAgentHops}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n)) set("maxAgentHops", Math.min(MAX_HOPS_LIMIT, Math.max(1, n)));
            }}
            className="h-8 w-20 text-right tabular-nums"
          />
        </SettingRow>
      )}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", advancedOpen && "rotate-90")} />
            Advanced
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <SettingRow
            title="Intent threshold"
            description={settings.replyMode === "intent"
              ? "How sure the classifier must be (0–1) before an agent replies without a mention."
              : "Used only when replies are by intent."}
          >
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              disabled={settings.replyMode !== "intent"}
              value={settings.intentThreshold}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) set("intentThreshold", Math.min(1, Math.max(0, n)));
              }}
              className="h-8 w-20 text-right tabular-nums"
            />
          </SettingRow>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export function FieldLabel({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-sm font-medium">{children}</span>
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}
