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

interface PwaInstallQrButtonProps {
  className?: string;
}

export function PwaInstallQrButton({ className }: PwaInstallQrButtonProps) {
  const [open, setOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
        const url = await QRCode.toDataURL(installUrl, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 260,
          color: { dark: "#0a0e1a", light: "#ffffff" },
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
              Install Polpo on phone
            </DialogTitle>
            <DialogDescription className="text-xs">
              Scan the QR code from your phone, then install the PWA from the browser menu.
            </DialogDescription>
          </DialogHeader>

          <div className="px-5 pb-5 pt-4 space-y-4">
            <div className="flex justify-center">
              <div className="flex h-[276px] w-[276px] items-center justify-center rounded-lg border border-border/50 bg-white p-2 shadow-sm">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="PWA install QR code" className="h-[260px] w-[260px]" />
                ) : (
                  <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/25 p-2">
              <code className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{installUrl}</code>
              <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1.5 text-xs" onClick={copyUrl}>
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>

            {isLocalhost && (
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                This address is local to this computer. To use the QR from a phone, run the UI on a network-reachable host or use a tunnel/HTTPS URL.
              </div>
            )}

            <div className="grid gap-2 text-[11px] leading-relaxed text-muted-foreground">
              <p><span className="font-medium text-foreground">iPhone/iPad:</span> open with Safari, tap Share, then Add to Home Screen.</p>
              <p><span className="font-medium text-foreground">Android:</span> open with Chrome, tap the menu, then Install app or Add to Home screen.</p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
