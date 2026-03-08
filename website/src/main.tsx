import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { App } from "./App";
import { InkPage } from "./pages/Ink";
import { InkDetailPage } from "./pages/InkDetail";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/ink" element={<InkPage />} />
        <Route path="/ink/*" element={<InkDetailPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
