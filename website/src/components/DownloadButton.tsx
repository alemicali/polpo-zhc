import { useState, useEffect } from "react";
import { Download, ChevronDown, Monitor, Apple, type LucideIcon } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// ── Types ──

type Platform = "linux" | "mac" | "windows" | "unknown";

interface PlatformInfo {
  platform: Platform;
  label: string;
  icon: LucideIcon;
  assets: { label: string; filename: string }[];
}

// ── GitHub Release URL builder ──

const REPO = "lumea-labs/polpo";

function releaseUrl(tag: string, filename: string): string {
  return `https://github.com/${REPO}/releases/download/${tag}/${filename}`;
}

// ── OS icons ──

function WindowsIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-13.051-1.851" />
    </svg>
  );
}

function LinuxIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 0 0-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.368 1.884 1.43.868.134 1.703-.272 2.191-.574.337-.21.529-.264.835-.198a.535.535 0 0 0 .576-.353.6.6 0 0 0 .015-.21c.003-.06.003-.12.003-.18 0-.4-.12-.8-.36-1.134-.36-.465-.768-.735-1.35-.865-.39-.09-.82-.167-1.022-.4-.064-.135-.135-.26-.205-.393.07-.135.133-.27.19-.398.39-.846.31-1.874-.133-3.073-.443-1.242-1.275-2.561-2.15-3.574-.905-1.07-1.069-2.042-1.105-3.093-.049-1.448.917-6.009-3.417-6.34a3.289 3.289 0 0 0-.358-.014z" />
    </svg>
  );
}

// ── Platform detection ──

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator as any).userAgentData?.platform?.toLowerCase() || navigator.platform?.toLowerCase() || "";

  if (platform.includes("mac") || ua.includes("macintosh")) return "mac";
  if (platform.includes("win") || ua.includes("windows")) return "windows";
  if (platform.includes("linux") || ua.includes("linux")) return "linux";
  return "unknown";
}

// ── Platform configs ──

const PLATFORMS: Record<Platform, PlatformInfo> = {
  linux: {
    platform: "linux",
    label: "Linux",
    icon: Monitor, // placeholder, we use LinuxIcon
    assets: [
      { label: "AppImage", filename: "Polpo-{version}.AppImage" },
      { label: ".deb", filename: "ui_{version}_amd64.deb" },
    ],
  },
  mac: {
    platform: "mac",
    label: "macOS",
    icon: Apple,
    assets: [
      { label: "DMG", filename: "Polpo-{version}.dmg" },
      { label: "ZIP", filename: "Polpo-{version}-mac.zip" },
    ],
  },
  windows: {
    platform: "windows",
    label: "Windows",
    icon: Monitor, // placeholder, we use WindowsIcon
    assets: [
      { label: "Installer", filename: "Polpo-Setup-{version}.exe" },
    ],
  },
  unknown: {
    platform: "unknown",
    label: "Desktop",
    icon: Monitor,
    assets: [],
  },
};

const PLATFORM_ORDER: Platform[] = ["linux", "mac", "windows"];

// ── Component ──

export function DownloadButton({ className = "" }: { className?: string }) {
  const [detected, setDetected] = useState<Platform>("unknown");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [latestTag, setLatestTag] = useState<string | null>(null);

  useEffect(() => {
    setDetected(detectPlatform());

    // Fetch latest release tag from GitHub API
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
      .then((r) => r.json())
      .then((data) => {
        if (data.tag_name) {
          setLatestTag(data.tag_name);
          setLatestVersion(data.tag_name.replace(/^v/, ""));
        }
      })
      .catch(() => {
        // Fallback — no release yet
      });
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target.closest("[data-download-dropdown]")) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  const primary = PLATFORMS[detected !== "unknown" ? detected : "linux"];
  const primaryAsset = primary.assets[0];
  const version = latestVersion || "0.1.17";
  const tag = latestTag || `v${version}`;

  const PlatformIcon = ({ platform, className: cn }: { platform: Platform; className?: string }) => {
    if (platform === "linux") return <LinuxIcon className={cn} />;
    if (platform === "windows") return <WindowsIcon className={cn} />;
    return <Apple className={cn} />;
  };

  // No release available yet — show coming soon
  if (!latestVersion && !latestTag) {
    return (
      <div className={`inline-flex items-center gap-2.5 rounded-lg border border-neutral-200 bg-white px-5 py-3 text-sm text-neutral-500 ${className}`}>
        <Download className="h-4 w-4" />
        <span>Desktop app coming soon</span>
      </div>
    );
  }

  return (
    <div className={`relative inline-flex ${className}`} data-download-dropdown>
      {/* Primary download button */}
      <a
        href={primaryAsset ? releaseUrl(tag, primaryAsset.filename.replace("{version}", version)) : "#"}
        className="inline-flex items-center gap-2.5 rounded-l-lg bg-neutral-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-neutral-800"
      >
        <PlatformIcon platform={primary.platform} className="h-4 w-4" />
        Download for {primary.label}
      </a>

      {/* Dropdown toggle */}
      <button
        onClick={() => setDropdownOpen((o) => !o)}
        className="inline-flex items-center rounded-r-lg border-l border-neutral-700 bg-neutral-950 px-2.5 py-3 text-white transition hover:bg-neutral-800"
      >
        <ChevronDown className={`h-4 w-4 transition-transform ${dropdownOpen ? "rotate-180" : ""}`} />
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {dropdownOpen && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.15 }}
            className="absolute top-full right-0 z-20 mt-2 min-w-[220px] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-lg"
          >
            <div className="px-3 py-2 border-b border-neutral-100">
              <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-400">
                v{version}
              </span>
            </div>
            {PLATFORM_ORDER.map((p) => {
              const info = PLATFORMS[p];
              return (
                <div key={p}>
                  {info.assets.map((asset) => (
                    <a
                      key={asset.filename}
                      href={releaseUrl(tag, asset.filename.replace("{version}", version))}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm text-neutral-700 transition hover:bg-neutral-50"
                      onClick={() => setDropdownOpen(false)}
                    >
                      <PlatformIcon platform={p} className="h-4 w-4 text-neutral-400" />
                      <span>{info.label}</span>
                      <span className="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-mono text-neutral-500">
                        {asset.label}
                      </span>
                    </a>
                  ))}
                </div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
