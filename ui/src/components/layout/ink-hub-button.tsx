import { Store } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { config } from "@/lib/config";

/** Polpo Ink Hub, next to the install QR, GitHub and theme in the top bar (desktop only). */
export function InkHubButton() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={config.inkHubUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hidden lg:inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all"
        >
          <Store className="h-4 w-4" />
          <span className="sr-only">Polpo Ink Hub</span>
        </a>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">Polpo Ink Hub</TooltipContent>
    </Tooltip>
  );
}
