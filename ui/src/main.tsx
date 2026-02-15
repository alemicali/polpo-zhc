import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { PolpoProvider } from "@openpolpo/react-sdk";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { App } from "./app";
import { config, resolveProjectId } from "./lib/config";
import "./index.css";

/**
 * Bootstrap wrapper — resolves the projectId before rendering.
 * Supports autodiscovery: if VITE_POLPO_PROJECT_ID is "auto" or unset,
 * it fetches GET /projects and uses the first available project.
 */
function Root() {
  const [projectId, setProjectId] = useState<string | null>(
    config.projectId !== "auto" ? config.projectId : null,
  );

  useEffect(() => {
    if (projectId) return;
    resolveProjectId().then(setProjectId);
  }, []);

  if (!projectId) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "system-ui" }}>
        Connecting to Polpo...
      </div>
    );
  }

  return (
    <PolpoProvider
      baseUrl={config.baseUrl}
      projectId={projectId}
      apiKey={config.apiKey}
    >
      <TooltipProvider>
        <App />
        <Toaster position="bottom-right" richColors />
      </TooltipProvider>
    </PolpoProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Root />
    </BrowserRouter>
  </StrictMode>
);
