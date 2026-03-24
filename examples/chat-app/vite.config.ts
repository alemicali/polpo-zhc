import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Target: cloud local (api.polpo.localhost) or production (api.polpo.sh)
const API_TARGET = process.env.POLPO_PROXY_TARGET ?? "http://api.polpo.localhost";
const isCloud = !API_TARGET.includes("localhost:") || API_TARGET.includes("polpo.localhost");

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    proxy: {
      // OpenAI-compatible completions: always /v1/chat/completions
      "/v1/chat": {
        target: API_TARGET,
        changeOrigin: true,
        // Cloud uses /v1, self-hosted uses /v1 too (OpenAI compat)
      },
      // Polpo API routes: /api/v1/* on self-hosted, /v1/* on cloud
      "/api/v1": {
        target: API_TARGET,
        changeOrigin: true,
        ...(isCloud ? { rewrite: (path: string) => path.replace(/^\/api\/v1/, "/v1") } : {}),
      },
    },
  },
});
