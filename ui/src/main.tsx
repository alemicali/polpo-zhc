import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { App } from "./app";
import { config } from "./lib/config";
import { bootstrapPalette } from "./lib/palette";
import { bootstrapAppearance } from "./lib/appearance";
import { bootstrapTheme } from "./hooks/use-theme";
// Iconify glyphs are generated as small, local subsets and registered by the
// components that use them. No icon depends on the public Iconify API.
import "./index.css";

function keepPwaCurrent(): void {
  if (!("serviceWorker" in navigator)) return;

  const wasControlled = navigator.serviceWorker.controller !== null;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!wasControlled || reloading) return;
    reloading = true;
    window.location.reload();
  });

  const checkForUpdate = () => {
    void navigator.serviceWorker.getRegistration().then((registration) => registration?.update()).catch(() => {
      // Updates are best effort; an offline PWA continues using its current shell.
    });
  };
  window.addEventListener("focus", checkForUpdate);
  window.setInterval(checkForUpdate, 60 * 60 * 1_000);
}

keepPwaCurrent();

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const apiBase = config.baseUrl.replace(/\/$/, "");
  const isPolpoApi = apiBase
    ? rawUrl.startsWith(apiBase)
    : rawUrl.startsWith("/api/") || rawUrl.startsWith("/v1/");
  if (!isPolpoApi || init?.credentials) return nativeFetch(input, init);
  return nativeFetch(input, { ...init, credentials: "include" });
};

// Apply saved theme/palette before React mounts to avoid a flash of default colours
bootstrapTheme();
bootstrapPalette();
bootstrapAppearance();

// Use HashRouter for Electron (file:// protocol), BrowserRouter for web
const isFileProtocol = window.location.protocol === "file:";
const Router = isFileProtocol ? HashRouter : BrowserRouter;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router>
      <TooltipProvider>
        <App />
        <Toaster position="bottom-right" richColors />
      </TooltipProvider>
    </Router>
  </StrictMode>
);
