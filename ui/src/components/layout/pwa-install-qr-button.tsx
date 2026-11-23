import { useEffect, useMemo, useState } from "react";
// `qrcode` is ~50 KB. Loaded only when the user opens the popover.
import { Check, Copy, Loader2, QrCode, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { productName, useInstanceBranding } from "@/lib/branding";

/** A theme token as #rrggbb (the QR encoder takes hex only); null when the browser can't resolve it. */
function tokenHex(name: string): string | null {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!value) return null;
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null;
  }
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
}

/**
 * The QR's colours from the look: the darker of foreground/background for the modules, the lighter
 * for the quiet zone, so it is always dark on light (what every phone camera reads) in both themes.
 * Too little contrast between them: the look's canvas (--canvas-foreground on --canvas, dark on
 * light by default); unresolvable: the encoder's own black on white.
 */
function qrColors(): { dark: string; light: string } | undefined {
  const fg = tokenHex("--foreground");
  const bg = tokenHex("--background");
  if (!fg || !bg || Math.abs(luminance(fg) - luminance(bg)) < 100) {
    const ink = tokenHex("--canvas-foreground");
    const sheet = tokenHex("--canvas");
    return ink && sheet ? { dark: ink, light: sheet } : undefined;
  }
  return luminance(fg) < luminance(bg) ? { dark: fg, light: bg } : { dark: bg, light: fg };
}

interface PwaInstallQrButtonProps {
  className?: string;
}

export function PwaInstallQrButton({ className }: PwaInstallQrButtonProps) {
  const [open, setOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [qrLight, setQrLight] = useState<string | undefined>(undefined);
  const branding = useInstanceBranding();

  const installUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URL("/", window.location.origin).href;
  }, []);

  const isLocalhost = useMemo(() => {
    if (typeof window === "undefined") return false;
    return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  }, []);

  useEffect(() => {
    if (!open || !installUrl) return;
    let cancelled = false;
    setQrDataUrl(null);
    void (async () => {
      try {
        const { default: QRCode } = await import("qrcode");
        const colors = qrColors();
        if (!cancelled) setQrLight(colors?.light);
        const url = await QRCode.toDataURL(installUrl, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 260,
          ...(colors ? { color: colors } : {}),
        });
        if (!cancelled) setQrDataUrl(url);
      } catch {
        if (!cancelled) setQrDataUrl(null);
      }
    })();
    return () => { cancelled = true; };
  }, [installUrl, open]);

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(installUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all", className)}
            onClick={() => setOpen(true)}
          >
            <QrCode className="h-4 w-4" />
            <span className="sr-only">Install PWA on phone</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">Install on phone</TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[420px] p-0 overflow-hidden">
          <DialogHeader className="px-5 pt-5 pb-0">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Smartphone className="h-4 w-4 text-primary" />
              Install {productName(branding)} on phone
            </DialogTitle>
            <DialogDescription className="text-xs">
              Scan the QR code from your phone, then install the PWA from the browser menu.
            </DialogDescription>
          </DialogHeader>

          <div className="px-5 pb-5 pt-4 space-y-4">
            <div className="flex justify-center">
              <div className="flex h-[276px] w-[276px] items-center justify-center rounded-lg border border-border/50 p-2 shadow-card" style={{ background: qrLight ?? "var(--canvas)" }}>
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="PWA install QR code" className="h-[260px] w-[260px]" />
                ) : (
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/25 p-2">
              <code className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{installUrl}</code>
              <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1.5 text-xs" onClick={copyUrl}>
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>

            {isLocalhost && (
              <div className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-caption leading-relaxed text-warning">
                This address is local to this computer. To use the QR from a phone, run the UI on a network-reachable host or use a tunnel/HTTPS URL.
              </div>
            )}

            <div className="grid gap-2 text-caption leading-relaxed text-muted-foreground">
              <p><span className="font-medium text-foreground">iPhone/iPad:</span> open with Safari, tap Share, then Add to Home Screen.</p>
              <p><span className="font-medium text-foreground">Android:</span> open with Chrome, tap the menu, then Install app or Add to Home screen.</p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
