import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { PolpoProvider } from "@lumea-labs/polpo-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ChatProvider } from "@/hooks/chat-context";
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
        <ChatProvider>
          <TooltipProvider>
            <App />
            <Toaster position="bottom-right" richColors />
          </TooltipProvider>
        </ChatProvider>
      </PolpoProvider>
    </BrowserRouter>
  </StrictMode>
);
