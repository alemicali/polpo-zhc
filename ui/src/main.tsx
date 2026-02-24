import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { PolpoProvider } from "@openpolpo/react-sdk";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { App } from "./app";
import { config } from "./lib/config";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <PolpoProvider
        baseUrl={config.baseUrl}
        apiKey={config.apiKey}
      >
        <TooltipProvider>
          <App />
          <Toaster position="bottom-right" richColors />
        </TooltipProvider>
      </PolpoProvider>
    </BrowserRouter>
  </StrictMode>
);
