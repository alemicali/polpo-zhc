import { useLocation } from "react-router-dom";
import { Sun, Moon, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/hooks/use-theme";

const titles: Record<string, string> = {
  "/dashboard": "Mission Control",
  "/plans": "Plans",
  "/tasks": "Tasks",
  "/agents": "Agents",
  "/activity": "Activity",
  "/chat": "Chat",
  "/memory": "Memory",
  "/logs": "Logs",
};

function resolveTitle(pathname: string): string {
  if (titles[pathname]) return titles[pathname];
  if (pathname.startsWith("/plans/")) return "Plan Detail";
  if (pathname.startsWith("/tasks/")) return "Task Detail";
  return "Polpo";
}

export function Header() {
  const { pathname } = useLocation();
  const title = resolveTitle(pathname);
  const { theme, resolved, setTheme } = useTheme();

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              {resolved === "dark" ? (
                <Moon className="h-4 w-4" />
              ) : (
                <Sun className="h-4 w-4" />
              )}
              <span className="sr-only">Toggle theme</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setTheme("light")}>
              <Sun className="h-3.5 w-3.5 mr-2" />
              Light
              {theme === "light" && <span className="ml-auto text-[10px] text-muted-foreground">Active</span>}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("dark")}>
              <Moon className="h-3.5 w-3.5 mr-2" />
              Dark
              {theme === "dark" && <span className="ml-auto text-[10px] text-muted-foreground">Active</span>}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("system")}>
              <Monitor className="h-3.5 w-3.5 mr-2" />
              System
              {theme === "system" && <span className="ml-auto text-[10px] text-muted-foreground">Active</span>}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono">
          polpo serve
        </kbd>
      </div>
    </header>
  );
}
