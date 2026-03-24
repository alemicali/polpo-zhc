import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PolpoProvider } from "@polpo-ai/react";
import { App } from "./App";
import "./styles.css";

const BASE_URL = import.meta.env.VITE_POLPO_URL ?? "http://localhost:1355";
const API_KEY = import.meta.env.VITE_POLPO_API_KEY ?? "";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PolpoProvider baseUrl={BASE_URL} apiKey={API_KEY}>
      <App />
    </PolpoProvider>
  </StrictMode>,
);
