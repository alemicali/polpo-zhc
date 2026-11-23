import { ChevronDown, ChevronRight, FileText, MoreHorizontal, Plus } from "lucide-react";
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
      <ul className="grid gap-0.5">
        {tabs.map((tab, index) => (
          <li key={tab.id} className={tab.id === activeId
            ? "group flex min-w-0 items-center gap-0.5 rounded-control bg-accent text-foreground"
            : "group flex min-w-0 items-center gap-0.5 rounded-control text-muted-foreground hover:bg-muted hover:text-foreground"}>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1 rounded-control px-1 py-1 text-left text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={tab.title}
              aria-current={tab.id === activeId ? "page" : undefined}
              onClick={() => onSelect(tab.id)}
            >
              <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{tab.title}</span>
            </button>
            {onAction && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" aria-label={`More actions for ${tab.title}`} title={`More actions for ${tab.title}`}><MoreHorizontal /></Button>
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
      {onAdd && <Button type="button" size="sm" variant="ghost" className="mt-0.5 gap-1 px-1 text-sm font-normal text-muted-foreground"
        aria-label="Add tab" onClick={onAdd}><Plus className="size-3.5" />New tab…</Button>}
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
