import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { OrchestraProvider } from "@openpolpo/react-sdk";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { App } from "./app";
import { config } from "./lib/config";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <OrchestraProvider
        baseUrl={config.baseUrl}
        projectId={config.projectId}
        apiKey={config.apiKey}
      >
        <TooltipProvider>
          <App />
          <Toaster position="bottom-right" richColors />
        </TooltipProvider>
      </OrchestraProvider>
    </BrowserRouter>
  </StrictMode>
);
