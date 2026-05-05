import { useEffect, useState } from "react";
import { LogOut, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { config } from "@/lib/config";
import { cn } from "@/lib/utils";

type AuthState = "loading" | "hidden" | "visible";

export function LogoutButton({ className }: { className?: string }) {
  const [state, setState] = useState<AuthState>("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`${config.baseUrl}/api/v1/auth/status`, { credentials: "include" })
      .then((res) => res.json())
      .then((body) => {
        if (!alive) return;
        setState(body?.ok && body.data?.enabled ? "visible" : "hidden");
      })
      .catch(() => {
        if (alive) setState("hidden");
      });
    return () => { alive = false; };
  }, []);

  const logout = async () => {
    setBusy(true);
    try {
      await fetch(`${config.baseUrl}/api/v1/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      window.location.assign("/login");
    }
  };

  if (state !== "visible") return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all", className)}
          onClick={logout}
          disabled={busy}
          aria-label="Log out"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">Log out</TooltipContent>
    </Tooltip>
  );
}
