import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { visualizer } from "rollup-plugin-visualizer";
import path from "path";
import { fileURLToPath } from "url";
import { appearanceKit, bootScriptSource } from "./src/lib/appearance-kit";
import { CHANGELOG } from "./src/lib/changelog";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isElectron = process.env.POLPO_ELECTRON === "1";

/** The browser chrome's colour per palette, [light, dark] (lib/appearance-kit.ts, from index.css). */
const THEME_COLORS = appearanceKit().THEME_COLORS;
/** The default look's page background (dark, Tide Pool); server.mjs serves the instance's own. */
const DEFAULT_CHROME = THEME_COLORS.tide[1];

const pwaPlugin = VitePWA({
  registerType: "autoUpdate",
  manifest: {
    name: "Polpo ZHC — AI Factory",
    short_name: "Polpo ZHC",
    description:
      "Monitor and orchestrate your AI coding agent team",
    theme_color: DEFAULT_CHROME,
    background_color: DEFAULT_CHROME,
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
    // A new build takes over at once: a waiting worker would keep serving the previous app shell,
    // whose lazy chunks no longer exist after a deploy ("Failed to fetch dynamically imported module").
    skipWaiting: true,
    clientsClaim: true,
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

/**
 * The look before the first paint: index.html's <!-- polpo:appearance-boot --> becomes an inline
 * script (lib/appearance-kit.ts) that puts the theme, palette and custom tokens on <html> from
 * runtime-config.js and localStorage, before the stylesheet paints.
 */
function appearanceBootPlugin(): Plugin {
  let buildBaseUrl = "";
  let assetBase = "/";
  return {
    name: "polpo-appearance-boot",
    configResolved(config) {
      buildBaseUrl = String(config.env.VITE_POLPO_API_URL ?? "");
      assetBase = config.base || "/";
    },
    transformIndexHtml(html) {
      return html
        // the browser chrome before the inline script sets the look's (the built-in default's page background)
        .replace("<!-- polpo:theme-color -->", `<meta name="theme-color" content="${DEFAULT_CHROME}" />`)
        .replace("<!-- polpo:appearance-boot -->", `<script>${bootScriptSource(buildBaseUrl, assetBase)}</script>`);
    },
  };
}

/**
 * dist/whats-new-ids.json: the ids of the What's new entries in this build. The UI server
 * (server.mjs) records the time it first serves a build containing each id and inlines those
 * times into runtime-config.js, so the changelog shows when each entry went online.
 */
/**
 * dist/theme-colors.json: each palette's page background, [light, dark]. The UI server (server.mjs)
 * serves manifest.webmanifest with the instance's own (its custom background, else its palette's,
 * in its theme), so an installed app's splash and title bar match the look.
 */
function themeColorsPlugin(): Plugin {
  return {
    name: "polpo-theme-colors",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "theme-colors.json", source: `${JSON.stringify(THEME_COLORS)}\n` });
    },
  };
}

function whatsNewIdsPlugin(): Plugin {
  return {
    name: "polpo-whats-new-ids",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "whats-new-ids.json",
        source: `${JSON.stringify({ ids: CHANGELOG.map((entry) => entry.id) })}\n`,
      });
    },
  };
}

export default defineConfig({
  base: isElectron ? "./" : "/",
  plugins: [
    appearanceBootPlugin(),
    whatsNewIdsPlugin(),
    themeColorsPlugin(),
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
