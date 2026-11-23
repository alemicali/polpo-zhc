import { ChevronDown, FileText, MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ArtifactDocTab } from "./artifact-doc-tabs";

export type DocTabAction = "rename" | "duplicate" | "earlier" | "later" | "delete";

export function DocTabNavigation({ tabs, activeId, onSelect, onAdd, onAction }: {
  tabs: ArtifactDocTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd?: () => void;
  onAction?: (action: DocTabAction, tab: ArtifactDocTab) => void;
}) {
  return (
    <nav aria-label="Document tabs" className="not-prose">
      <div className="mb-1.5 flex items-center justify-between gap-1 px-1">
        <h2 className="truncate text-sm font-semibold">Tabs</h2>
        {onAdd && <Button type="button" size="icon-xs" variant="ghost" aria-label="Add tab" title="Add tab" onClick={onAdd}><Plus /></Button>}
      </div>
      <ul className="grid gap-0.5">
        {tabs.map((tab, index) => (
          <li key={tab.id} className={tab.id === activeId
            ? "flex min-w-0 items-center gap-0.5 rounded-control bg-primary/10 text-primary"
            : "flex min-w-0 items-center gap-0.5 rounded-control text-muted-foreground hover:bg-muted hover:text-foreground"}>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={tab.title}
              aria-current={tab.id === activeId ? "page" : undefined}
              onClick={() => onSelect(tab.id)}
            >
              <FileText className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{tab.title}</span>
            </button>
            {onAction && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={`More actions for ${tab.title}`} title={`More actions for ${tab.title}`}><MoreHorizontal /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => onAction("rename", tab)}>Rename tab</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onAction("duplicate", tab)}>Duplicate tab</DropdownMenuItem>
                  <DropdownMenuItem disabled={index === 0} onSelect={() => onAction("earlier", tab)}>Move tab up</DropdownMenuItem>
                  <DropdownMenuItem disabled={index === tabs.length - 1} onSelect={() => onAction("later", tab)}>Move tab down</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled={tabs.length === 1} onSelect={() => onAction("delete", tab)}>Delete tab</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function DocTabPicker({ tabs, activeId, onSelect }: {
  tabs: ArtifactDocTab[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="max-w-full" aria-label="Choose document tab">
          <FileText />
          <span className="truncate">{tabs.find((tab) => tab.id === activeId)?.title}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {tabs.map((tab) => (
          <DropdownMenuItem key={tab.id} onSelect={() => onSelect(tab.id)} aria-current={tab.id === activeId ? "page" : undefined}>
            {tab.title}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
