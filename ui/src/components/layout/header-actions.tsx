/**
 * The header's right-hand actions, shared by the sidebar layout's Header and the chat-first
 * layout's pages header:
 *
 * - **What's new** (the chat-first header only: the sidebar layout has the What's new cards at the
 *   bottom of the sidebar): an icon with the unread count, opening the What's new drawer;
 * - **the look**: light / dark / system and the palette (nothing else);
 * - **⋯ (more)**: the secondary entries — Install app (QR), Polpo Ink Hub, GitHub, the sidebar
 *   style (sidebar layout) and Log out (when the instance has a sign-in).
 */
import { useState } from "react";
import {
  Check,
  Github,
  ListTree,
  LogOut,
  Megaphone,
  Monitor,
  Moon,
  MoreHorizontal,
  Palette as PaletteIcon,
  PanelLeft,
  QrCode,
  Store,
  Sun,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { config } from "@/lib/config";
import { useTheme } from "@/hooks/use-theme";
import { usePalette, PALETTES } from "@/lib/palette";
import { openWhatsNew, useWhatsNewOpen } from "@/hooks/use-whats-new-drawer";
import { useUnseenChangelog } from "@/hooks/use-whats-new";
import { setSidebarStyle, useSidebarStyle } from "@/hooks/use-sidebar-style";
import { useInstanceLogout } from "@/hooks/use-instance-logout";
import { PwaInstallDialog } from "./pwa-install-dialog";

export const GITHUB_URL = "https://github.com/alemicali/polpo-zhc";

const ICON_BUTTON = "h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all";

/** What's new, with the number of entries not seen yet. */
export function WhatsNewButton({ className }: { className?: string }) {
  const open = useWhatsNewOpen();
  const unread = useUnseenChangelog().length;
  const label = unread > 0 ? `What's new (${unread} unread)` : "What's new";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-testid="whats-new-button"
          className={cn(
            "relative h-8 w-8 rounded-lg transition-all",
            open ? "bg-primary/10 text-primary hover:bg-primary/15" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            className,
          )}
          onClick={openWhatsNew}
          aria-label={label}
        >
          <Megaphone className="h-4 w-4" />
          {unread > 0 && (
            <span
              data-testid="whats-new-unread"
              aria-hidden
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-pill bg-primary px-1 text-micro font-semibold leading-none text-primary-foreground ring-2 ring-background"
            >
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">What's new</TooltipContent>
    </Tooltip>
  );
}

/** Light / dark / system and the palette. */
export function ThemeMenu({ className }: { className?: string }) {
  const { theme, resolved, setTheme } = useTheme();
  const { palette, setPalette } = usePalette();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn(ICON_BUTTON, className)} aria-label="Theme">
          {resolved === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px] bg-popover/95 backdrop-blur-surface border-border/50">
        <DropdownMenuLabel className="text-label text-muted-foreground/70">Mode</DropdownMenuLabel>
        {([
          { id: "light" as const, label: "Light", icon: Sun },
          { id: "dark" as const, label: "Dark", icon: Moon },
          { id: "system" as const, label: "System", icon: Monitor },
        ]).map(({ id, label, icon: Icon }) => (
          <DropdownMenuItem key={id} onSelect={() => setTheme(id)} className="gap-2.5 text-xs">
            <Icon className="h-3.5 w-3.5" /> {label}
            {theme === id && <Check className="ml-auto h-3 w-3 text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-label text-muted-foreground/70 flex items-center gap-1.5">
          <PaletteIcon className="h-3 w-3" /> Palette
        </DropdownMenuLabel>
        {PALETTES.map((p) => {
          const swatch = resolved === "dark" ? p.swatchDark : p.swatchLight;
          return (
            <DropdownMenuItem key={p.id} onSelect={() => setPalette(p.id)} className="gap-2.5 text-xs py-1.5">
              {/* Three-stop swatch — bg, primary, accent — overlapping discs */}
              <span className="relative inline-flex shrink-0 h-4 w-4 items-center justify-center">
                <span className="absolute inset-0 rounded-pill ring-1 ring-border/60" style={{ backgroundColor: swatch[0] }} />
                <span className="absolute h-3 w-3 rounded-pill" style={{ backgroundColor: swatch[1], left: "30%", top: "10%" }} />
                <span className="absolute h-2 w-2 rounded-pill" style={{ backgroundColor: swatch[2], left: "55%", top: "50%" }} />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block leading-tight">{p.name}</span>
                <span className="block text-micro text-muted-foreground/70 leading-tight">{p.blurb}</span>
              </span>
              {palette === p.id && <Check className="h-3 w-3 text-primary shrink-0" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** ⋯ — the secondary entries of the header. */
export function HeaderMoreMenu({ className, showSidebarStyle = true }: { className?: string; showSidebarStyle?: boolean }) {
  const [installOpen, setInstallOpen] = useState(false);
  const sidebarStyle = useSidebarStyle();
  const { available: canLogOut, busy: loggingOut, logout } = useInstanceLogout();
  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className={cn(ICON_BUTTON, className)} aria-label="More">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">More</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-[200px] bg-popover/95 backdrop-blur-surface border-border/50">
          {/* the QR is for opening the dashboard on a phone: not offered on the phone itself */}
          <DropdownMenuItem onSelect={() => setInstallOpen(true)} className="hidden gap-2.5 text-xs lg:flex">
            <QrCode className="h-3.5 w-3.5" /> Install app
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="gap-2.5 text-xs">
            <a href={config.inkHubUrl} target="_blank" rel="noopener noreferrer">
              <Store className="h-3.5 w-3.5" /> Polpo Ink Hub
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="gap-2.5 text-xs">
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
              <Github className="h-3.5 w-3.5" /> GitHub
            </a>
          </DropdownMenuItem>
          {showSidebarStyle && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-label text-muted-foreground/70">Sidebar</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setSidebarStyle("classic")} className="gap-2.5 text-xs">
                <PanelLeft className="h-3.5 w-3.5" /> Classic
                {sidebarStyle === "classic" && <Check className="ml-auto h-3 w-3 text-primary" />}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSidebarStyle("drill-in")} className="gap-2.5 text-xs">
                <ListTree className="h-3.5 w-3.5" /> Drill-in (new)
                {sidebarStyle === "drill-in" && <Check className="ml-auto h-3 w-3 text-primary" />}
              </DropdownMenuItem>
            </>
          )}
          {canLogOut && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void logout()} disabled={loggingOut} className="gap-2.5 text-xs">
                <LogOut className="h-3.5 w-3.5" /> Log out
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <PwaInstallDialog open={installOpen} onOpenChange={setInstallOpen} />
    </>
  );
}
