import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { ensureVscodeIconsPack } from "@/lib/iconify-bootstrap";

/**
 * Maps a filename / path to a vscode-icons icon name.
 * Falls back to a generic file icon when no match.
 *
 * The mapping mirrors the most common cases from vscode-icons; we don't
 * try to cover every edge case — anything missing renders as the default
 * file icon, which is fine.
 */
function iconName(path: string): string {
  const name = path.split("/").pop() ?? path;
  const lower = name.toLowerCase();

  // Special filenames (matched whole-name first)
  const specials: Record<string, string> = {
    "dockerfile": "vscode-icons:file-type-docker",
    "dockerfile.dev": "vscode-icons:file-type-docker",
    "docker-compose.yml": "vscode-icons:file-type-docker2",
    "docker-compose.yaml": "vscode-icons:file-type-docker2",
    ".gitignore": "vscode-icons:file-type-git",
    ".gitattributes": "vscode-icons:file-type-git",
    ".gitmodules": "vscode-icons:file-type-git",
    ".env": "vscode-icons:file-type-dotenv",
    ".env.local": "vscode-icons:file-type-dotenv",
    ".env.development": "vscode-icons:file-type-dotenv",
    ".env.production": "vscode-icons:file-type-dotenv",
    "package.json": "vscode-icons:file-type-node",
    "package-lock.json": "vscode-icons:file-type-node",
    "pnpm-lock.yaml": "vscode-icons:file-type-pnpm",
    "pnpm-workspace.yaml": "vscode-icons:file-type-pnpm",
    "yarn.lock": "vscode-icons:file-type-yarn",
    "tsconfig.json": "vscode-icons:file-type-tsconfig",
    "vite.config.ts": "vscode-icons:file-type-vite",
    "vite.config.js": "vscode-icons:file-type-vite",
    "tailwind.config.ts": "vscode-icons:file-type-tailwind",
    "tailwind.config.js": "vscode-icons:file-type-tailwind",
    "postcss.config.js": "vscode-icons:file-type-postcss",
    "next.config.js": "vscode-icons:file-type-next",
    "next.config.ts": "vscode-icons:file-type-next",
    "readme.md": "vscode-icons:file-type-readme",
    "license": "vscode-icons:file-type-license",
    "makefile": "vscode-icons:file-type-makefile",
  };
  if (specials[lower]) return specials[lower];

  // Multi-segment extensions (e.g. ".d.ts", ".test.ts")
  if (lower.endsWith(".d.ts")) return "vscode-icons:file-type-typescriptdef";
  if (lower.endsWith(".test.ts") || lower.endsWith(".spec.ts")) return "vscode-icons:file-type-testts";
  if (lower.endsWith(".test.tsx") || lower.endsWith(".spec.tsx")) return "vscode-icons:file-type-reacttest";
  if (lower.endsWith(".test.js") || lower.endsWith(".spec.js")) return "vscode-icons:file-type-testjs";

  // Single-segment extension lookup
  const ext = (lower.match(/\.([^./\\]+)$/)?.[1]) ?? "";
  const byExt: Record<string, string> = {
    ts: "vscode-icons:file-type-typescript",
    tsx: "vscode-icons:file-type-reactts",
    js: "vscode-icons:file-type-js",
    jsx: "vscode-icons:file-type-reactjs",
    mjs: "vscode-icons:file-type-js",
    cjs: "vscode-icons:file-type-js",
    json: "vscode-icons:file-type-json",
    jsonl: "vscode-icons:file-type-json",
    md: "vscode-icons:file-type-markdown",
    markdown: "vscode-icons:file-type-markdown",
    mdx: "vscode-icons:file-type-mdx",
    html: "vscode-icons:file-type-html",
    htm: "vscode-icons:file-type-html",
    css: "vscode-icons:file-type-css",
    scss: "vscode-icons:file-type-scss",
    sass: "vscode-icons:file-type-sass",
    less: "vscode-icons:file-type-less",
    py: "vscode-icons:file-type-python",
    go: "vscode-icons:file-type-go",
    rs: "vscode-icons:file-type-rust",
    rb: "vscode-icons:file-type-ruby",
    java: "vscode-icons:file-type-java",
    kt: "vscode-icons:file-type-kotlin",
    swift: "vscode-icons:file-type-swift",
    c: "vscode-icons:file-type-c",
    cpp: "vscode-icons:file-type-cpp",
    cc: "vscode-icons:file-type-cpp",
    h: "vscode-icons:file-type-cheader",
    hpp: "vscode-icons:file-type-cppheader",
    cs: "vscode-icons:file-type-csharp",
    php: "vscode-icons:file-type-php",
    sh: "vscode-icons:file-type-shell",
    bash: "vscode-icons:file-type-shell",
    zsh: "vscode-icons:file-type-shell",
    fish: "vscode-icons:file-type-shell",
    yaml: "vscode-icons:file-type-yaml",
    yml: "vscode-icons:file-type-yaml",
    toml: "vscode-icons:file-type-toml",
    xml: "vscode-icons:file-type-xml",
    sql: "vscode-icons:file-type-sql",
    graphql: "vscode-icons:file-type-graphql",
    gql: "vscode-icons:file-type-graphql",
    proto: "vscode-icons:file-type-protobuf",
    svg: "vscode-icons:file-type-svg",
    png: "vscode-icons:file-type-image",
    jpg: "vscode-icons:file-type-image",
    jpeg: "vscode-icons:file-type-image",
    gif: "vscode-icons:file-type-image",
    webp: "vscode-icons:file-type-image",
    ico: "vscode-icons:file-type-image",
    bmp: "vscode-icons:file-type-image",
    avif: "vscode-icons:file-type-image",
    pdf: "vscode-icons:file-type-pdf2",
    zip: "vscode-icons:file-type-zip2",
    tar: "vscode-icons:file-type-zip2",
    gz: "vscode-icons:file-type-zip2",
    tgz: "vscode-icons:file-type-zip2",
    rar: "vscode-icons:file-type-zip2",
    "7z": "vscode-icons:file-type-zip2",
    mp3: "vscode-icons:file-type-audio",
    wav: "vscode-icons:file-type-audio",
    flac: "vscode-icons:file-type-audio",
    mp4: "vscode-icons:file-type-video",
    webm: "vscode-icons:file-type-video",
    mov: "vscode-icons:file-type-video",
    lock: "vscode-icons:file-type-lock",
    log: "vscode-icons:file-type-log",
    csv: "vscode-icons:file-type-excel",
    txt: "vscode-icons:file-type-text",
    env: "vscode-icons:file-type-dotenv",
    nginx: "vscode-icons:file-type-nginx",
    conf: "vscode-icons:file-type-text",
    ini: "vscode-icons:file-type-text",
  };
  if (byExt[ext]) return byExt[ext];

  return "vscode-icons:default-file";
}

export function FileIcon({ path, className }: { path: string; className?: string }) {
  // Lazy-load the (~3.5 MB) vscode-icons pack on first render. While the
  // fetch is in-flight, render an empty span of the same size to avoid
  // layout jumps. Subsequent FileIcon mounts share the cached promise.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    ensureVscodeIconsPack().then(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);
  if (!ready) return <span className={className} aria-hidden />;
  return <Icon icon={iconName(path)} className={className} />;
}
