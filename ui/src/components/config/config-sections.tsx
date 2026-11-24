/**
 * The Configuration page's sections and its section bar.
 *
 * With the drill-in sidebar (sidebar layout) the sidebar's Settings level already lists the
 * sections (links to /config?section=…): the page shows the current section's title instead of
 * its own tab bar. Classic sidebar and chat-first layout: the tab bar.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { baseSections, useConfigSectionsInSidebar, type ConfigSectionId } from "@/lib/config-sections";

/** The section bar: the tabs, or the current section's title when the sidebar lists them. */
export function ConfigSectionBar({ active, onSelect, actions }: {
  active: ConfigSectionId;
  onSelect: (id: ConfigSectionId) => void;
  /** At the end of the bar (the reload button). */
  actions?: ReactNode;
}) {
  const inSidebar = useConfigSectionsInSidebar();
  const current = baseSections.find((s) => s.id === active) ?? baseSections[0];
  const CurrentIcon = current.icon;

  return (
    <div className="flex items-center gap-2 shrink-0">
      {inSidebar ? (
        <h2 data-testid="config-section-title" className="flex min-w-0 flex-1 items-center gap-2 font-heading text-h3">
          <CurrentIcon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{current.label}</span>
        </h2>
      ) : (
        <div role="group" aria-label="Configuration sections" className="flex items-center gap-1 overflow-x-auto scrollbar-none flex-1 pb-0.5">
          {baseSections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={active === id}
              onClick={() => onSelect(id)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer",
                active === id
                  ? "bg-accent text-accent-foreground shadow-card"
                  : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              {label}
            </button>
          ))}
        </div>
      )}
      {actions}
    </div>
  );
}
