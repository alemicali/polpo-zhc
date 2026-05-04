import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isElectron = process.env.POLPO_ELECTRON === "1";

const pwaPlugin = VitePWA({
  registerType: "autoUpdate",
  includeAssets: ["favicon.svg", "icons/*.png"],
  manifest: {
    name: "ZHC by Polpo — AI Agent Wrangler",
    short_name: "ZHC by Polpo",
    description:
      "Monitor and orchestrate your AI coding agent team",
    theme_color: "#0a0e1a",
    background_color: "#0a0e1a",
    display: "standalone",
    orientation: "portrait-primary",
    scope: "/",
    start_url: "/",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/icons/icon-192-maskable.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  },
  workbox: {
    importScripts: ["push-handlers.js"],
    navigateFallback: "/index.html",
    globPatterns: ["**/*.{js,css,html,svg,woff2}"],
    navigateFallbackDenylist: [/^\/api\//, /^\/v1\//],
    // Bundle has crept past 2 MB — bump the precache cap rather than fail
    // the build. Code-splitting can come later as a perf pass.
    maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
    runtimeCaching: [
      {
        urlPattern: /\.(png|jpg|svg|woff2)$/,
        handler: "CacheFirst",
        options: {
          cacheName: "assets",
          expiration: { maxAgeSeconds: 60 * 60 * 24 * 30 },
        },
      },
    ],
  },
  devOptions: {
    // Enable the PWA service worker in web dev so install/update behavior can
    // be tested locally. Keep it disabled for Electron/file:// builds.
    enabled: !isElectron,
  },
});

export default defineConfig({
  base: isElectron ? "./" : "/",
  plugins: [
    react(),
    tailwindcss(),
    // Disable PWA in Electron builds — service workers break file:// protocol
    ...(isElectron ? [] : [pwaPlugin]),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-recharts": ["recharts"],
          "vendor-ui": ["radix-ui"],
        },
      },
    },
  },
  preview: {
    allowedHosts: true,
  },
  server: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:3890",
        changeOrigin: true,
      },
      "/v1": {
        target: "http://localhost:3890",
        changeOrigin: true,
      },
    },
  },
});
