import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { visualizer } from "rollup-plugin-visualizer";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isElectron = process.env.POLPO_ELECTRON === "1";

const pwaPlugin = VitePWA({
  registerType: "autoUpdate",
  manifest: {
    name: "Polpo ZHC — AI Factory",
    short_name: "Polpo ZHC",
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
    cleanupOutdatedCaches: true,
    navigateFallback: "/index.html",
    // Precache only the application shell. Entry chunks use the `app-`
    // prefix below so this cannot accidentally match generic `index-*`
    // chunks emitted by dependencies.
    globPatterns: [
      "index.html",
      "assets/app-*.js",
      "assets/vendor-react-*.js",
      "assets/vendor-ui-*.js",
      "assets/*.css",
      "favicon.svg",
    ],
    maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
    runtimeCaching: [
      {
        // Hashed chunks are immutable: cache-first avoids a redundant network
        // revalidation on every repeat visit. A changed chunk gets a new URL.
        urlPattern: /\/assets\/[A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)?\.js$/,
        handler: "CacheFirst",
        options: {
          cacheName: "lazy-chunks",
          expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
        },
      },
      {
        urlPattern: /\.(png|jpg|svg|woff2|webp)$/,
        handler: "CacheFirst",
        options: {
          cacheName: "assets",
          expiration: { maxAgeSeconds: 60 * 60 * 24 * 30 },
        },
      },
      {
        // API responses must always go to the network — auth-aware, dynamic.
        urlPattern: ({ url }) => url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/"),
        handler: "NetworkOnly",
      },
    ],
  },
  devOptions: {
    // A dev service worker can retain transformed Vite modules and make HMR
    // appear intermittently stale. PWA behavior is exercised by `ui serve`.
    enabled: false,
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
        entryFileNames: "assets/app-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-ui": ["radix-ui"],
        },
      },
      // Emit a treemap report at dist/stats.html on every build so we can
      // track bundle health over time. Set BUNDLE_VISUALIZE=0 to skip.
      plugins: process.env.BUNDLE_VISUALIZE === "0"
        ? []
        : [visualizer({
            filename: "dist/stats.html",
            template: "treemap",
            gzipSize: true,
            brotliSize: true,
          }) as unknown as import("vite").Plugin],
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
        ws: true,
      },
      "/v1": {
        target: "http://localhost:3890",
        changeOrigin: true,
      },
      "/ws": {
        target: "http://localhost:3890",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
