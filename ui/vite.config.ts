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
  includeAssets: ["favicon.svg", "icons/*.png"],
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
    navigateFallback: "/index.html",
    // Precache only the shell — entry, vendor splits, css, html, fonts.
    // Lazy chunks (route bundles, shiki grammars, mermaid diagrams, the
    // base64-inlined onig WASM, the iconify packs) are fetched on demand
    // via runtimeCaching so first-visit network cost stays small.
    globPatterns: [
      "index.html",
      "manifest.webmanifest",
      "assets/index-*.{js,css}",
      "assets/vendor-*.{js,css}",
      "**/*.{css,svg,woff2,png,webp}",
    ],
    globIgnores: [
      // Lazy route + vendor chunks
      "assets/coding-*.js",
      "assets/terminal-*.js",
      "assets/mission-detail-*.js",
      "assets/model-picker-*.js",
      // Iconify packs (~11 MB combined)
      "assets/icons.json-*.js",
      // Shiki grammars + themes
      "assets/{abap,actionscript-3,ada,angular-html,angular-ts,apache,apex,apl,applescript,ara,asciidoc,asm,astro,awk,ayu-dark,ayu-mirage,ballerina,bat,beancount,berry,bibtex,bicep,blade,c,c3,cadence,catppuccin-frappe,catppuccin-latte,catppuccin-macchiato,catppuccin-mocha,clojure,cmake,cobol,codeowners,coffee,common-lisp,coq,cpp,crystal,csharp,css,csv,cue,cypher,d,dart,dax,desktop,diff,docker,dotenv,dream-maker,dreamweaver,edge,elixir,elm,emacs-lisp,erb,erlang,fennel,fish,fluent,fortran-fixed-form,fortran-free-form,fsharp,gdresource,gdscript,gdshader,genie,gherkin,gleam,glimmer-js,glimmer-ts,glsl,gnuplot,go,graphql,groovy,hack,haml,handlebars,haskell,haxe,hcl,hjson,hlsl,html,html-derivative,http,hxml,hy,imba,ini,jade,java,javascript,jinja,jison,json,json5,jsonc,jsonl,jsonnet,jssm,jsx,julia,kotlin,kusto,latex,lean,less,liquid,log,logo,lua,luau,make,markdown,marko,matlab,mdc,mdx,mermaid,mojo,monkey-patch-c,move,narrat,nextflow,nginx,nim,nix,noir,objective-c,objective-cpp,ocaml,one-dark-pro,one-light,pascal,perl,php,plsql,po,polar,postcss,powerquery,powershell,prisma,prolog,proto,pug,puppet,purescript,python,qml,qmldir,qss,r,racket,raku,razor,reg,regexp,rel,riscv,rst,ruby,rust,sas,sass,scala,scheme,scss,sdbl,shaderlab,shellsession,smalltalk,solidity,solar-flare,solarized-dark,solarized-light,soy,sparql,splunk-spl,sql,squirrel,ssh-config,stata,stylus,svelte,swift,system-verilog,systemd,tasl,tcl,terraform,tex,toml,ts-tags,tsv,tsx,turtle,twig,typescript,typespec,typst,v,vala,vb,verilog,vhdl,viml,vue,vue-html,vyper,wasm,wenyan,wgsl,wikitext,wolfram,xml,xsl,yaml,zenscript,zig,sandcastle}-*.js",
      // Inlined base64 WASM
      "assets/wasm-*.js",
    ],
    maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
    runtimeCaching: [
      {
        // Lazy JS chunks — stale-while-revalidate keeps offline use fast and
        // self-heals on rolling deployments.
        urlPattern: /\/assets\/[A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)?\.js$/,
        handler: "StaleWhileRevalidate",
        options: { cacheName: "lazy-chunks" },
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
