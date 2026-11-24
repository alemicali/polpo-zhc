/**
 * Configuration → Appearance → Navigation sidebar: the instance default (shared by everyone,
 * settings.appearance.sidebarStyle) and this person's own choice (this browser).
 */
import { useState } from "react";
import { Globe, Laptop, ListTree, Loader2, PanelLeft } from "lucide-react";
import { toast } from "sonner";
import { SegmentedControl, ToggleGroupItem } from "@/components/ui/toggle-group";
import { setSidebarStyle, useSidebarStyleState, type SidebarStyle } from "@/hooks/use-sidebar-style";

const STYLE_LABEL: Record<SidebarStyle, string> = { classic: "Classic", "drill-in": "Drill-in" };

export function SidebarStyleSettings({ onSaveInstanceDefault }: {
  /** Save the instance default (settings.appearance.sidebarStyle). */
  onSaveInstanceDefault?: (style: SidebarStyle) => Promise<void>;
}) {
  const { style, user, instance } = useSidebarStyleState();
  const [busy, setBusy] = useState(false);

  const saveInstance = async (next: SidebarStyle) => {
    if (!onSaveInstanceDefault || next === instance) return;
    setBusy(true);
    try {
      await onSaveInstanceDefault(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save the instance default");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="sidebar-style-heading">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 id="sidebar-style-heading" className="flex items-center gap-1.5 text-label text-muted-foreground">
          <ListTree className="h-3.5 w-3.5" /> Navigation sidebar
        </h3>
        <span className="text-micro text-muted-foreground">Now: {STYLE_LABEL[style]}</span>
      </div>
      <div className="grid gap-4 border-y border-border/60 py-4 sm:grid-cols-2">
        <div className="grid content-start gap-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium"><Laptop className="h-3.5 w-3.5" /> For you (this browser)</span>
          <SegmentedControl
            size="sm"
            aria-label="Your sidebar"
            value={user ?? "instance"}
            onValueChange={(value: string) => setSidebarStyle(value === "instance" ? null : value as SidebarStyle)}
          >
            <ToggleGroupItem value="instance">Instance default</ToggleGroupItem>
            <ToggleGroupItem value="classic">Classic</ToggleGroupItem>
            <ToggleGroupItem value="drill-in">Drill-in</ToggleGroupItem>
          </SegmentedControl>
          <p className="text-caption text-muted-foreground">
            Classic lists every page. Drill-in groups them: Work, Team, Content, Tools and Settings open their pages inside the sidebar, with a Back row.
          </p>
        </div>
        <div className="grid content-start gap-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <Globe className="h-3.5 w-3.5" /> Instance default
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          </span>
          <SegmentedControl
            size="sm"
            aria-label="Instance default sidebar"
            value={instance}
            disabled={!onSaveInstanceDefault || busy}
            onValueChange={(value: string) => void saveInstance(value as SidebarStyle)}
          >
            <ToggleGroupItem value="classic"><PanelLeft className="h-4 w-4" />Classic</ToggleGroupItem>
            <ToggleGroupItem value="drill-in"><ListTree className="h-4 w-4" />Drill-in</ToggleGroupItem>
          </SegmentedControl>
          <p className="text-caption text-muted-foreground">
            What everyone sees until they choose their own. Shared with every user.
          </p>
        </div>
      </div>
    </section>
  );
}
