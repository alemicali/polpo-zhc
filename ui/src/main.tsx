import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import { PolpoProvider } from "@polpo-ai/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ChatProvider } from "@/hooks/chat-context";
import { App } from "./app";
import { config } from "./lib/config";
import "./index.css";

// Use HashRouter for Electron (file:// protocol), BrowserRouter for web
const isFileProtocol = window.location.protocol === "file:";
const Router = isFileProtocol ? HashRouter : BrowserRouter;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router>
      <PolpoProvider
        baseUrl={config.baseUrl}
        apiKey={config.apiKey}
      >
        <ChatProvider>
          <TooltipProvider>
            <App />
            <Toaster position="bottom-right" richColors />
          </TooltipProvider>
        </ChatProvider>
      </PolpoProvider>
    </Router>
  </StrictMode>
);
