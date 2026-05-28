/**
 * AppliedRulesPanel — show every notification rule that would fire for a
 * task or mission, grouped by scope (task → mission → global) with
 * shadow markers when a more-specific scope replaces a less-specific one.
 *
 * Pure rendering — resolution lives in @/lib/applied-rules.
 */

import { Link } from "react-router-dom";
import { Bell, Layers, Target, Globe, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { summarizeRule } from "@/lib/rule-summary";
import {
  resolveAppliedRulesForMission,
  resolveAppliedRulesForTask,
  type AnyRule,
  type AppliedRule,
  type ScopedRules,
  type RuleScope,
} from "@/lib/applied-rules";

interface CommonProps {
  /** When true, shadowed rules are dimmed; when false, hidden. Default: true. */
  showShadowed?: boolean;
  className?: string;
}

interface MissionVariantProps extends CommonProps {
  variant: "mission";
  missionScoped?: ScopedRules;
  globalRules?: AnyRule[];
}

interface TaskVariantProps extends CommonProps {
  variant: "task";
  taskScoped?: ScopedRules;
  missionScoped?: ScopedRules;
  globalRules?: AnyRule[];
}

export type AppliedRulesPanelProps = MissionVariantProps | TaskVariantProps;

const SCOPE_META: Record<RuleScope, { label: string; icon: typeof Layers; tone: string; chip: string; winsOver?: string }> = {
  task: {
    label: "Task scope",
    icon: Target,
    tone: "border-emerald-500/30 bg-emerald-500/5",
    chip: "text-emerald-600 border-emerald-500/30",
    winsOver: "wins over mission + global",
  },
  mission: {
    label: "Mission scope",
    icon: Layers,
    tone: "border-sky-500/30 bg-sky-500/5",
    chip: "text-sky-600 border-sky-500/30",
    winsOver: "wins over global",
  },
  global: {
    label: "Global scope",
    icon: Globe,
    tone: "border-border/40 bg-muted/15",
    chip: "text-muted-foreground border-border/40",
  },
};

export function AppliedRulesPanel(props: AppliedRulesPanelProps) {
  const applied: AppliedRule[] =
    props.variant === "mission"
      ? resolveAppliedRulesForMission({
          missionScoped: props.missionScoped,
          globalRules: props.globalRules,
        })
      : resolveAppliedRulesForTask({
          taskScoped: props.taskScoped,
          missionScoped: props.missionScoped,
          globalRules: props.globalRules,
        });

  const showShadowed = props.showShadowed ?? true;
  const visible = applied.filter(a => showShadowed || !a.shadowed);

  if (visible.length === 0) {
    return (
      <div className={cn("rounded-lg border border-dashed border-border/40 px-6 py-10 text-center", props.className)}>
        <Bell className="h-8 w-8 mx-auto opacity-30 mb-2" />
        <p className="text-sm text-muted-foreground">
          No notification rules would fire for {props.variant === "mission" ? "this mission" : "this task"}.
        </p>
        <p className="text-[11px] text-muted-foreground/70 mt-1">
          Configure rules in{" "}
          <Link to="/config" className="text-primary hover:underline inline-flex items-center gap-0.5">
            Config → Rules <ExternalLink className="h-2.5 w-2.5" />
          </Link>{" "}
          to receive alerts for lifecycle events.
        </p>
      </div>
    );
  }

  // Group by scope while preserving original ordering.
  const buckets = new Map<RuleScope, AppliedRule[]>();
  for (const a of visible) {
    const list = buckets.get(a.scope) ?? [];
    list.push(a);
    buckets.set(a.scope, list);
  }

  const order: RuleScope[] = ["task", "mission", "global"];

  return (
    <div className={cn("space-y-4", props.className)}>
      {order.filter(s => buckets.has(s)).map(scope => {
        const meta = SCOPE_META[scope];
        const items = buckets.get(scope)!;
        const Icon = meta.icon;
        return (
          <section key={scope} className={cn("rounded-lg border px-3 py-2.5", meta.tone)}>
            <header className="flex items-center gap-2 mb-2">
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold">{meta.label}</span>
              <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5", meta.chip)}>
                {items.length} {items.length === 1 ? "rule" : "rules"}
              </Badge>
              {meta.winsOver && (
                <span className="text-[10px] text-muted-foreground ml-auto">{meta.winsOver}</span>
              )}
            </header>
            <ul className="space-y-2">
              {items.map(a => (
                <li
                  key={`${a.scope}:${a.rule.id}`}
                  className={cn(
                    "rounded-md border border-border/30 bg-background/60 px-2.5 py-2",
                    a.shadowed && "opacity-50",
                  )}
                >
                  <div className="flex items-start gap-2 mb-1">
                    <Bell className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                    <span className="text-xs font-semibold flex-1 min-w-0">{a.rule.name ?? a.rule.id}</span>
                    {a.rule.severity && a.rule.severity !== "info" && (
                      <Badge
                        variant={a.rule.severity === "critical" ? "destructive" : "secondary"}
                        className="text-[9px] h-4 px-1.5"
                      >
                        {a.rule.severity}
                      </Badge>
                    )}
                    {a.shadowed && (
                      <Badge variant="outline" className="text-[9px] h-4 px-1.5 text-muted-foreground">
                        shadowed
                      </Badge>
                    )}
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground mb-1.5 pl-5">
                    {summarizeRule(a.rule)}
                  </p>
                  <div className="flex flex-wrap items-center gap-1 pl-5">
                    {a.matchedEvents.map(ev => (
                      <code
                        key={ev}
                        className="text-[10px] font-mono px-1 py-0.5 rounded bg-muted/40 border border-border/20"
                      >
                        {ev}
                      </code>
                    ))}
                    {(a.rule.channels?.length ?? 0) > 0 && (
                      <>
                        <span className="text-muted-foreground text-[10px] mx-0.5">→</span>
                        {a.rule.channels!.map(ch => (
                          <Badge key={ch} variant="outline" className="text-[10px] h-4">
                            {ch}
                          </Badge>
                        ))}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
