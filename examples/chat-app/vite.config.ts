import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1": {
        target: "https://api.polpo.sh",
        changeOrigin: true,
      },
      "/api/v1": {
        target: "https://api.polpo.sh",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/v1/, "/v1"),
      },
    },
  },
});
