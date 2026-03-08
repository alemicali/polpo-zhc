import { useRef, useState, useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion, useInView, AnimatePresence } from "motion/react";
import {
  Package,
  BookOpen,
  Users,
  Search,
  ArrowRight,
  ArrowUpDown,
  Copy,
  Check,
  GitBranch,
  ChevronRight,
  Download,
  TrendingUp,
  Clock,
  X,
  type LucideIcon,
} from "lucide-react";
import { getAllTags, formatInstalls, type InkPackage, type PackageType } from "../data/ink-packages";
import { useInkPackages } from "../hooks/use-ink-packages";

/* ── Helpers ──────────────────────────────────────────────────────── */

function GitHubIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function ExtLink({ href, className = "", children }: { href: string; className?: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>;
}

function Reveal({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  return (
    <motion.div ref={ref} className={className} initial={{ opacity: 0, y: 16 }} animate={inView ? { opacity: 1, y: 0 } : {}} transition={{ duration: 0.4, delay, ease: [0.22, 1, 0.36, 1] }}>
      {children}
    </motion.div>
  );
}

/* ── Type badge config ────────────────────────────────────────────── */

const TYPE_CONFIG: Record<PackageType, { icon: LucideIcon; label: string; color: string; bg: string }> = {
  playbook: { icon: BookOpen, label: "playbook", color: "text-emerald-600", bg: "bg-emerald-50 border-emerald-200" },
  agent: { icon: Users, label: "agent", color: "text-violet-600", bg: "bg-violet-50 border-violet-200" },
  company: { icon: Package, label: "company", color: "text-rose-600", bg: "bg-rose-50 border-rose-200" },
};

const FILTER_TABS: { key: PackageType | "all"; label: string; count: (pkgs: InkPackage[]) => number }[] = [
  { key: "all", label: "All", count: (p) => p.length },
  { key: "playbook", label: "Playbooks", count: (p) => p.filter((x) => x.type === "playbook").length },
  { key: "agent", label: "Agents", count: (p) => p.filter((x) => x.type === "agent").length },
  { key: "company", label: "Companies", count: (p) => p.filter((x) => x.type === "company").length },
];

/* ── Sort options ─────────────────────────────────────────────────── */

type SortKey = "installs" | "trending" | "recent";

const SORT_OPTIONS: { key: SortKey; label: string; icon: LucideIcon }[] = [
  { key: "installs", label: "Most Installed", icon: Download },
  { key: "trending", label: "Trending (24h)", icon: TrendingUp },
  { key: "recent", label: "Recent", icon: Clock },
];

function sortPackages(packages: InkPackage[], sortKey: SortKey): InkPackage[] {
  const sorted = [...packages];
  switch (sortKey) {
    case "installs":
      return sorted.sort((a, b) => b.installs - a.installs);
    case "trending":
      return sorted.sort((a, b) => b.installs24h - a.installs24h);
    case "recent":
      return sorted.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  }
}

/* ── Copy button ──────────────────────────────────────────────────── */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={copy} className="group/copy inline-flex items-center gap-1.5 transition" title="Copy install command">
      <AnimatePresence mode="wait">
        {copied ? (
          <motion.span key="check" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}>
            <Check className="h-3.5 w-3.5 text-emerald-500" />
          </motion.span>
        ) : (
          <motion.span key="copy" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}>
            <Copy className="h-3.5 w-3.5 text-neutral-400 group-hover/copy:text-neutral-700" />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

/* ── Package row ──────────────────────────────────────────────────── */

function PackageRow({ pkg, index, sortKey }: { pkg: InkPackage; index: number; sortKey: SortKey }) {
  const config = TYPE_CONFIG[pkg.type];
  const Icon = config.icon;
  const installCmd = `polpo ink add ${pkg.source}`;

  const statValue = sortKey === "trending"
    ? `+${formatInstalls(pkg.installs24h)}`
    : sortKey === "recent"
    ? pkg.publishedAt
    : formatInstalls(pkg.installs);

  return (
    <Reveal delay={index * 0.02}>
      <Link
        to={`/ink/${pkg.source}/${pkg.name}`}
        className="group flex items-start gap-4 border-b border-neutral-100 px-6 py-4 transition hover:bg-neutral-50 last:border-0"
      >
        {/* Rank */}
        <span className="mt-1 w-6 shrink-0 text-right font-mono text-xs text-neutral-300">
          {index + 1}
        </span>

        {/* Icon */}
        <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${config.bg}`}>
          <Icon className={`h-4 w-4 ${config.color}`} strokeWidth={1.5} />
        </div>

        {/* Main content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className="font-display text-sm font-bold text-neutral-900 group-hover:text-coral transition">{pkg.name}</span>
            <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium ${config.bg} ${config.color}`}>
              {config.label}
            </span>
            {pkg.version && (
              <span className="font-mono text-[10px] text-neutral-400">v{pkg.version}</span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-neutral-500 line-clamp-1">{pkg.description}</p>
          <div className="mt-1.5 flex items-center gap-3">
            <span className="flex items-center gap-1 text-xs text-neutral-400">
              <GitBranch className="h-3 w-3" />
              {pkg.source}
            </span>
            {pkg.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">
                {tag}
              </span>
            ))}
          </div>
        </div>

        {/* Stat column */}
        <div className="hidden shrink-0 items-center gap-4 sm:flex">
          <span className={`font-mono text-xs ${sortKey === "trending" ? "text-emerald-600 font-semibold" : "text-neutral-500"}`}>
            {statValue}
          </span>
        </div>

        {/* Install command (desktop) */}
        <div className="hidden shrink-0 items-center gap-2 md:flex">
          <code className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-1.5 font-mono text-xs text-neutral-600 opacity-0 transition group-hover:opacity-100">
            {installCmd}
          </code>
          <div className="opacity-0 transition group-hover:opacity-100">
            <CopyButton text={installCmd} />
          </div>
        </div>

        {/* Arrow */}
        <ChevronRight className="mt-2 h-4 w-4 shrink-0 text-neutral-300 transition group-hover:text-neutral-500" />
      </Link>
    </Reveal>
  );
}

/* ── Navbar ────────────────────────────────────────────────────────── */

function InkNavbar() {
  return (
    <header className="fixed top-0 z-50 w-full border-b border-neutral-100 bg-white/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <Link to="/" className="flex items-center">
          <img src="/logo-text.svg" alt="Polpo" className="h-6" />
        </Link>
        <nav className="flex items-center gap-5">
          <Link
            to="/ink"
            className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3.5 py-1.5 text-sm font-semibold text-indigo-700 transition hover:border-indigo-300 hover:bg-indigo-100"
          >
            <Package className="h-3.5 w-3.5" />
            Ink Hub
          </Link>
          <ExtLink
            href="https://docs.polpo.sh"
            className="flex items-center gap-1.5 text-sm text-neutral-500 transition hover:text-neutral-950"
          >
            <BookOpen className="h-3.5 w-3.5" />
            Docs
          </ExtLink>
          <ExtLink
            href="https://github.com/lumea-labs/polpo"
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 transition hover:border-neutral-400 hover:text-neutral-950"
          >
            <GitHubIcon className="h-4 w-4" />
            lumea-labs/polpo
          </ExtLink>
        </nav>
      </div>
    </header>
  );
}

/* ── Main Ink page ────────────────────────────────────────────────── */

export function InkPage() {
  const { packages, loading, error } = useInkPackages();
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<PackageType | "all">("all");
  const [sortKey, setSortKey] = useState<SortKey>("installs");
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());

  const allTags = useMemo(() => getAllTags(packages), [packages]);

  const toggleTag = (tag: string) => {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const clearTags = () => setActiveTags(new Set());

  const filtered = useMemo(() => {
    let result = packages;

    // Type filter
    if (activeFilter !== "all") {
      result = result.filter((p) => p.type === activeFilter);
    }

    // Tag filter
    if (activeTags.size > 0) {
      result = result.filter((p) => {
        for (const tag of activeTags) {
          if (p.tags.includes(tag)) return true;
        }
        return false;
      });
    }

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.tags.some((t) => t.includes(q)) ||
          p.source.toLowerCase().includes(q),
      );
    }

    // Sort
    return sortPackages(result, sortKey);
  }, [packages, search, activeFilter, sortKey, activeTags]);

  const totalInstalls = useMemo(() => packages.reduce((sum, p) => sum + p.installs, 0), [packages]);

  return (
    <div className="min-h-screen bg-white text-neutral-950">
      <div className="grain" />
      <InkNavbar />

      {/* Hero */}
      <section className="relative overflow-hidden pt-28 pb-12 md:pt-36 md:pb-16">
        <div className="hero-mesh pointer-events-none absolute inset-0" style={{ maskImage: "linear-gradient(to bottom, black 40%, transparent 90%)", WebkitMaskImage: "linear-gradient(to bottom, black 40%, transparent 90%)" }} />
        <div className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 h-[500px] w-[700px] bg-[radial-gradient(ellipse,rgba(232,104,138,0.04)_0%,rgba(59,62,115,0.02)_40%,transparent_70%)]" />

        <div className="relative mx-auto max-w-3xl px-6 text-center">
          <Reveal>
            <h1 className="font-display text-4xl font-extrabold tracking-tight text-neutral-950 sm:text-5xl">
              Ink Hub
            </h1>
            <p className="mt-2 text-sm font-mono text-neutral-400 tracking-wide">The Polpo Package Registry</p>
            <p className="mt-3 text-lg text-neutral-500">
              Discover, share, and install playbooks, agents, and complete company configs — directly from any GitHub repo. No publish step. No central authority.
            </p>
          </Reveal>

          <Reveal delay={0.08}>
            <div className="mx-auto mt-6 flex max-w-md items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-2.5 font-mono text-sm">
              <span className="text-neutral-400 select-none">$</span>
              <span className="text-neutral-700">polpo ink add </span>
              <span className="text-coral">owner/repo</span>
            </div>
          </Reveal>

          <Reveal delay={0.12}>
            <div className="mt-4 flex items-center justify-center gap-6 font-mono text-xs text-neutral-400">
              {loading ? (
                <span>Loading...</span>
              ) : error ? (
                <span className="text-red-400">Failed to load packages</span>
              ) : (
                <>
                  <span>{packages.length} packages</span>
                  <span>{formatInstalls(totalInstalls)} installs</span>
                </>
              )}
            </div>
          </Reveal>
        </div>
      </section>

      {/* Search + filter + list */}
      <section className="relative pb-24 md:pb-32">
        <div className="mx-auto max-w-4xl px-6">
          {/* Search bar */}
          <Reveal delay={0.14}>
            <div className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 shadow-sm">
              <Search className="h-4.5 w-4.5 text-neutral-400" />
              <input
                type="text"
                placeholder="Search packages..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 bg-transparent text-sm text-neutral-900 placeholder:text-neutral-400 outline-none"
              />
              <kbd className="hidden rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400 sm:inline">/</kbd>
            </div>
          </Reveal>

          {/* Controls row: type filter + sort */}
          <Reveal delay={0.18}>
            <div className="mt-4 flex items-center justify-between gap-4">
              {/* Type filter tabs */}
              <div className="flex gap-1">
                {FILTER_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveFilter(tab.key)}
                    className={`rounded-lg px-3 py-1.5 font-mono text-xs transition ${
                      activeFilter === tab.key
                        ? "bg-neutral-900 text-white"
                        : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
                    }`}
                  >
                    {tab.label}
                    <span className="ml-1.5 opacity-60">{tab.count(packages)}</span>
                  </button>
                ))}
              </div>

              {/* Sort selector */}
              <div className="flex items-center gap-1">
                {SORT_OPTIONS.map((opt) => {
                  const SortIcon = opt.icon;
                  return (
                    <button
                      key={opt.key}
                      onClick={() => setSortKey(opt.key)}
                      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition ${
                        sortKey === opt.key
                          ? "bg-neutral-900 text-white"
                          : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
                      }`}
                    >
                      <SortIcon className="h-3 w-3" />
                      <span className="hidden sm:inline">{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </Reveal>

          {/* Tag filters */}
          <Reveal delay={0.22}>
            <div className="mt-3">
              <div className="flex flex-wrap gap-1.5">
                {activeTags.size > 0 && (
                  <button
                    onClick={clearTags}
                    className="flex items-center gap-1 rounded-md border border-neutral-300 bg-neutral-100 px-2 py-1 font-mono text-[10px] text-neutral-600 transition hover:bg-neutral-200"
                  >
                    <X className="h-2.5 w-2.5" />
                    Clear
                  </button>
                )}
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => toggleTag(tag)}
                    className={`rounded-md border px-2 py-1 font-mono text-[10px] transition ${
                      activeTags.has(tag)
                        ? "border-coral bg-coral/10 text-coral font-semibold"
                        : "border-neutral-200 bg-white text-neutral-500 hover:border-neutral-300 hover:text-neutral-700"
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          </Reveal>

          {/* Package list */}
          <div className="mt-6 overflow-hidden rounded-xl border border-neutral-200 bg-white">
            {/* Header */}
            <div className="hidden border-b border-neutral-100 bg-neutral-50 px-6 py-2.5 md:flex md:items-center">
              <span className="w-6 shrink-0" />
              <span className="ml-4 w-8 shrink-0" />
              <span className="ml-4 flex-1 font-mono text-[10px] uppercase tracking-wider text-neutral-400">Package</span>
              <span className="w-16 text-right font-mono text-[10px] uppercase tracking-wider text-neutral-400">
                {sortKey === "installs" ? "Installs" : sortKey === "trending" ? "24h" : "Published"}
              </span>
              <span className="w-48" /> {/* install cmd space */}
              <span className="w-4" /> {/* arrow */}
            </div>

            {filtered.length > 0 ? (
              filtered.map((pkg, i) => <PackageRow key={`${pkg.source}/${pkg.name}`} pkg={pkg} index={i} sortKey={sortKey} />)
            ) : (
              <div className="px-6 py-12 text-center">
                <Search className="mx-auto mb-3 h-6 w-6 text-neutral-300" />
                <p className="text-sm text-neutral-500">No packages match your filters.</p>
                {activeTags.size > 0 && (
                  <button onClick={clearTags} className="mt-2 text-xs text-coral hover:underline">Clear tag filters</button>
                )}
              </div>
            )}

            {/* Footer */}
            <div className="border-t border-neutral-100 bg-neutral-50 px-6 py-3 flex items-center justify-between">
              <span className="font-mono text-xs text-neutral-400">
                {filtered.length} package{filtered.length !== 1 ? "s" : ""}
                {activeTags.size > 0 && ` (${activeTags.size} tag${activeTags.size !== 1 ? "s" : ""} active)`}
              </span>
              <ExtLink href="https://docs.polpo.sh/features/ink" className="flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-700 transition">
                How to publish <ArrowRight className="h-3 w-3" />
              </ExtLink>
            </div>
          </div>

          {/* How it works — compact */}
          <Reveal delay={0.24}>
            <div className="mt-12 rounded-xl border border-neutral-200 bg-neutral-50 p-6">
              <h2 className="font-display text-lg font-bold text-neutral-900">Publish your own packages</h2>
              <p className="mt-1.5 text-sm text-neutral-500">
                No account needed. Create a GitHub repo with the right file structure and anyone can install it.
              </p>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[
                  { path: "playbooks/<name>/playbook.json", type: "PlaybookDefinition" },
                  { path: "agents/<name>.json", type: "AgentConfig" },
                  { path: "companies/<name>/polpo.json", type: "PolpoFileConfig" },
                ].map((rule) => (
                  <div key={rule.path} className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2">
                    <ChevronRight className="h-3 w-3 text-coral" />
                    <div>
                      <code className="font-mono text-[11px] text-neutral-700">{rule.path}</code>
                      <p className="font-mono text-[10px] text-neutral-400">{rule.type}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex items-center gap-4">
                <ExtLink href="https://docs.polpo.sh/features/ink" className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-700 hover:text-neutral-950 transition">
                  Read the docs <ArrowRight className="h-3.5 w-3.5" />
                </ExtLink>
                <ExtLink href="https://github.com/lumea-labs/ink-registry" className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-700 transition">
                  <GitHubIcon className="h-3.5 w-3.5" />
                  Example registry
                </ExtLink>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-neutral-200 bg-neutral-50 py-8">
        <div className="mx-auto max-w-5xl px-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/logo-text.svg" alt="Polpo" className="h-4" />
            <span className="text-xs text-neutral-400">Ink Hub — Package Registry</span>
          </div>
          <div className="flex items-center gap-4">
            <ExtLink href="https://github.com/lumea-labs/polpo" className="text-xs text-neutral-400 hover:text-neutral-600 transition">GitHub</ExtLink>
            <ExtLink href="https://docs.polpo.sh" className="text-xs text-neutral-400 hover:text-neutral-600 transition">Docs</ExtLink>
            <span className="text-xs text-neutral-400">MIT License</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
