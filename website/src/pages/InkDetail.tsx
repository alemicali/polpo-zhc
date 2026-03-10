import { useRef, useState, useEffect, type ReactNode } from "react";
import { Link, useParams, Navigate } from "react-router-dom";
import { Navbar, GitHubIcon, ExtLink } from "../components/Navbar";
import { motion, useInView, AnimatePresence } from "motion/react";
import {
  Package,
  BookOpen,
  Users,
  ArrowLeft,
  Copy,
  Check,
  GitBranch,
  Shield,
  ChevronRight,
  Tag,
  User,
  FileCode,
  ExternalLink,
  Cpu,
  MessageSquare,
  ListChecks,
  Briefcase,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { type InkPackage, type PackageType } from "../data/ink-packages";

function Reveal({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  return (
    <motion.div ref={ref} className={className} initial={{ opacity: 0, y: 16 }} animate={inView ? { opacity: 1, y: 0 } : {}} transition={{ duration: 0.4, delay, ease: [0.22, 1, 0.36, 1] }}>
      {children}
    </motion.div>
  );
}

/* ── Type config ──────────────────────────────────────────────────── */

const TYPE_CONFIG: Record<PackageType, { icon: LucideIcon; label: string; color: string; bg: string; borderColor: string }> = {
  playbook: { icon: BookOpen, label: "Playbook", color: "text-emerald-600", bg: "bg-emerald-50", borderColor: "border-emerald-200" },
  agent: { icon: Users, label: "Agent", color: "text-violet-600", bg: "bg-violet-50", borderColor: "border-violet-200" },
  company: { icon: Package, label: "Company", color: "text-rose-600", bg: "bg-rose-50", borderColor: "border-rose-200" },
};

/* ── Copy button ──────────────────────────────────────────────────── */

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={copy}
      className="group inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-2.5 font-mono text-sm transition hover:border-neutral-400"
    >
      <span className="text-neutral-400 select-none">$</span>
      <code className="text-neutral-700">{text}</code>
      <AnimatePresence mode="wait">
        {copied ? (
          <motion.span key="check" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}>
            <Check className="ml-1 h-3.5 w-3.5 text-emerald-500" />
          </motion.span>
        ) : (
          <motion.span key="copy" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}>
            <Copy className="ml-1 h-3.5 w-3.5 text-neutral-400 opacity-0 transition group-hover:opacity-100 group-hover:text-neutral-700" />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

/* ── Navbar (shared) ───────────────────────────────────────────────── */

/* ── Related package row ──────────────────────────────────────────── */

function RelatedRow({ pkg }: { pkg: InkPackage }) {
  const config = TYPE_CONFIG[pkg.type];
  const Icon = config.icon;
  return (
    <Link
      to={`/ink/${pkg.source}/${pkg.name}`}
      className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-4 py-3 transition hover:border-neutral-300 hover:shadow-sm"
    >
      <div className={`flex h-7 w-7 items-center justify-center rounded-md border ${config.borderColor} ${config.bg}`}>
        <Icon className={`h-3.5 w-3.5 ${config.color}`} strokeWidth={1.5} />
      </div>
      <div className="min-w-0 flex-1">
        <span className="text-sm font-semibold text-neutral-900">{pkg.name}</span>
        <p className="text-xs text-neutral-500 line-clamp-1">{pkg.description}</p>
      </div>
      <ChevronRight className="h-4 w-4 text-neutral-300" />
    </Link>
  );
}

/* ── Human-readable content renderers ─────────────────────────────── */

/** Build the raw GitHub URL for a package's JSON file. */
function getPackageRawUrl(source: string, name: string, type: PackageType): string {
  const base = `https://raw.githubusercontent.com/${source}/main`;
  switch (type) {
    case "agent": return `${base}/agents/${name}.json`;
    case "playbook": return `${base}/playbooks/${name}/playbook.json`;
    case "company": return `${base}/companies/${name}/polpo.json`;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="font-display text-base font-bold text-neutral-900 mb-3">{children}</h3>;
}

function InfoRow({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <Icon className="h-4 w-4 mt-0.5 shrink-0 text-neutral-400" />
      <div className="min-w-0">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-400">{label}</span>
        <p className="text-sm text-neutral-700 mt-0.5">{value}</p>
      </div>
    </div>
  );
}

function ResponsibilityCard({ resp }: { resp: any }) {
  if (typeof resp === "string") {
    return (
      <div className="flex items-start gap-2 py-1.5">
        <Check className="h-3.5 w-3.5 mt-0.5 shrink-0 text-emerald-500" />
        <span className="text-sm text-neutral-700">{resp}</span>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-neutral-900">{resp.area || resp.name}</span>
        {resp.priority && (
          <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-medium ${
            resp.priority === "high" ? "bg-red-50 text-red-600 border border-red-200" :
            resp.priority === "medium" ? "bg-amber-50 text-amber-600 border border-amber-200" :
            "bg-neutral-50 text-neutral-500 border border-neutral-200"
          }`}>
            {resp.priority}
          </span>
        )}
      </div>
      {resp.description && (
        <p className="mt-1 text-xs text-neutral-500 leading-relaxed">{resp.description}</p>
      )}
    </div>
  );
}

function AgentContent({ data }: { data: any }) {
  const identity = data.identity;
  return (
    <div className="space-y-6">
      {/* Identity */}
      {identity && (
        <div>
          <SectionHeading>Identity</SectionHeading>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 space-y-1">
            {identity.title && <InfoRow icon={Briefcase} label="Title" value={identity.title} />}
            {identity.bio && <InfoRow icon={User} label="Bio" value={identity.bio} />}
            {identity.tone && <InfoRow icon={MessageSquare} label="Tone" value={identity.tone} />}
            {identity.personality && <InfoRow icon={User} label="Personality" value={identity.personality} />}
          </div>
        </div>
      )}

      {/* Responsibilities */}
      {identity?.responsibilities && identity.responsibilities.length > 0 && (
        <div>
          <SectionHeading>Responsibilities</SectionHeading>
          <div className="space-y-2">
            {identity.responsibilities.map((r: any, i: number) => (
              <ResponsibilityCard key={i} resp={r} />
            ))}
          </div>
        </div>
      )}

      {/* Allowed tools */}
      {data.allowedTools && data.allowedTools.length > 0 && (
        <div>
          <SectionHeading>Allowed Tools</SectionHeading>
          <div className="flex flex-wrap gap-1.5">
            {data.allowedTools.map((tool: string) => (
              <span key={tool} className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-white px-2.5 py-1 font-mono text-xs text-neutral-700">
                <Wrench className="h-3 w-3 text-neutral-400" />
                {tool}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* System prompt */}
      {data.systemPrompt && (
        <div>
          <SectionHeading>System Prompt</SectionHeading>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
            <p className="text-sm text-neutral-600 leading-relaxed whitespace-pre-wrap">{data.systemPrompt}</p>
          </div>
        </div>
      )}

      {/* Model */}
      {data.model && (
        <div>
          <SectionHeading>Model</SectionHeading>
          <div className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2">
            <Cpu className="h-4 w-4 text-neutral-400" />
            <code className="font-mono text-sm text-neutral-700">{data.model}</code>
          </div>
        </div>
      )}
    </div>
  );
}

function PlaybookContent({ data }: { data: any }) {
  const tasks = data.mission?.tasks ?? [];
  const params = data.parameters ?? [];
  return (
    <div className="space-y-6">
      {/* Parameters */}
      {params.length > 0 && (
        <div>
          <SectionHeading>Parameters</SectionHeading>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 overflow-hidden">
            {params.map((p: any, i: number) => (
              <div key={i} className="flex items-start gap-3 border-b border-neutral-100 last:border-0 px-4 py-3">
                <code className="shrink-0 rounded-md bg-white border border-neutral-200 px-2 py-0.5 font-mono text-xs text-violet-600 mt-0.5">
                  {"{{"}{ p.name }{"}}"}
                </code>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-neutral-700">{p.description}</p>
                  <div className="mt-1 flex flex-wrap gap-2 text-[10px] font-mono">
                    {p.required && <span className="text-red-500">required</span>}
                    {p.type && <span className="text-neutral-400">type: {p.type}</span>}
                    {p.default !== undefined && <span className="text-neutral-400">default: {String(p.default)}</span>}
                    {p.enum && <span className="text-neutral-400">options: {p.enum.join(", ")}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tasks */}
      {tasks.length > 0 && (
        <div>
          <SectionHeading>Mission Tasks ({tasks.length})</SectionHeading>
          <div className="space-y-3">
            {tasks.map((task: any, i: number) => (
              <div key={i} className="rounded-xl border border-neutral-200 bg-white p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-900 font-mono text-[10px] font-bold text-white">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-semibold text-neutral-900">{task.title}</h4>
                    <p className="mt-1 text-xs text-neutral-500 leading-relaxed">{task.description}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {task.assignTo && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-violet-50 border border-violet-200 px-2 py-0.5 font-mono text-[10px] text-violet-600">
                          <User className="h-2.5 w-2.5" />
                          {task.assignTo}
                        </span>
                      )}
                      {task.dependsOn?.map((dep: string) => (
                        <span key={dep} className="inline-flex items-center gap-1 rounded-md bg-neutral-50 border border-neutral-200 px-2 py-0.5 font-mono text-[10px] text-neutral-500">
                          depends on: {dep}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CompanyContent({ data }: { data: any }) {
  const teams = data.teams ?? [];
  return (
    <div className="space-y-6">
      {/* Settings */}
      {data.settings && (
        <div>
          <SectionHeading>Settings</SectionHeading>
          <div className="flex flex-wrap gap-2">
            {Object.entries(data.settings).map(([key, val]) => (
              <span key={key} className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1 font-mono text-xs text-neutral-700">
                <span className="text-neutral-400">{key}:</span> {String(val)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Teams and agents */}
      {teams.map((team: any, ti: number) => (
        <div key={ti}>
          <SectionHeading>
            Team: {team.name}
            {team.description && <span className="ml-2 text-sm font-normal text-neutral-400">— {team.description}</span>}
          </SectionHeading>
          <div className="space-y-3">
            {(team.agents ?? []).map((agent: any, ai: number) => (
              <div key={ai} className="rounded-xl border border-neutral-200 bg-white p-4">
                <div className="flex items-center gap-3 mb-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-violet-200 bg-violet-50">
                    <Users className="h-4 w-4 text-violet-600" strokeWidth={1.5} />
                  </div>
                  <div>
                    <span className="text-sm font-semibold text-neutral-900">{agent.name}</span>
                    {agent.role && <span className="ml-2 text-xs text-neutral-400">{agent.role}</span>}
                  </div>
                  {agent.model && (
                    <code className="ml-auto rounded-md bg-neutral-50 border border-neutral-200 px-2 py-0.5 font-mono text-[10px] text-neutral-500">
                      {agent.model}
                    </code>
                  )}
                </div>
                {agent.identity?.bio && (
                  <p className="text-xs text-neutral-500 leading-relaxed mb-2">{agent.identity.bio}</p>
                )}
                {agent.identity?.responsibilities && (
                  <div className="flex flex-wrap gap-1.5">
                    {agent.identity.responsibilities.map((r: any, ri: number) => (
                      <span key={ri} className="rounded-md bg-neutral-50 border border-neutral-100 px-2 py-0.5 text-[10px] text-neutral-600">
                        {typeof r === "string" ? r : r.area || r.description}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PackageContent({ source, name, type }: { source: string; name: string; type: PackageType }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const url = getPackageRawUrl(source, name, type);
    fetch(url, { signal: AbortSignal.timeout(8000) })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [source, name, type]);

  if (loading) {
    return <p className="text-sm text-neutral-400 py-4">Loading package content...</p>;
  }
  if (!data) return null;

  return (
    <Reveal delay={0.14}>
      <div className="space-y-2">
        <h2 className="font-display text-lg font-bold text-neutral-900">Package Content</h2>
        {type === "agent" && <AgentContent data={data} />}
        {type === "playbook" && <PlaybookContent data={data} />}
        {type === "company" && <CompanyContent data={data} />}
      </div>
    </Reveal>
  );
}

/* ── Detail page ──────────────────────────────────────────────────── */

export function InkDetailPage() {
  const { "*": splat } = useParams();
  const [pkg, setPkg] = useState<InkPackage | null>(null);
  const [related, setRelated] = useState<InkPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Route: /ink/:owner/:repo/:name
  // splat = "owner/repo/name"
  const parts = splat?.split("/") ?? [];
  const owner = parts[0];
  const repo = parts[1];
  const name = parts.slice(2).join("/");
  const source = `${owner}/${repo}`;

  useEffect(() => {
    if (parts.length < 3) { setNotFound(true); setLoading(false); return; }

    let cancelled = false;

    async function load() {
      try {
        // Fetch single package
        const res = await fetch(`/api/packages/${owner}/${repo}/${name}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) { if (!cancelled) setNotFound(true); return; }

        const data = await res.json() as { package: {
          source: string; name: string; type: string; description: string;
          tags: string[]; version: string; author: string; installs: number;
          installs24h: number; firstSeen: string; lastInstalled: string;
        } };
        if (cancelled) return;

        const p = data.package;
        setPkg({
          name: p.name,
          type: p.type as PackageType,
          description: p.description,
          source: p.source,
          tags: p.tags ?? [],
          version: p.version,
          author: p.author,
          installs: p.installs,
          installs24h: p.installs24h,
          publishedAt: p.firstSeen,
        });

        // Fetch all packages to find related ones from same source
        const allRes = await fetch("/api/packages", { signal: AbortSignal.timeout(5000) });
        if (allRes.ok && !cancelled) {
          const allData = await allRes.json() as { packages: Array<{
            source: string; name: string; type: string; description: string;
            tags: string[]; version: string; author: string; installs: number;
            installs24h: number; firstSeen: string;
          }> };
          setRelated(
            allData.packages
              .filter((r) => r.source === p.source && r.name !== p.name)
              .map((r) => ({
                name: r.name,
                type: r.type as PackageType,
                description: r.description,
                source: r.source,
                tags: r.tags ?? [],
                version: r.version,
                author: r.author,
                installs: r.installs,
                installs24h: r.installs24h,
                publishedAt: r.firstSeen,
              })),
          );
        }
      } catch {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [owner, repo, name]);

  if (notFound) return <Navigate to="/ink" replace />;

  if (loading || !pkg) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <p className="text-neutral-400 font-mono text-sm">Loading...</p>
      </div>
    );
  }

  const config = TYPE_CONFIG[pkg.type];
  const Icon = config.icon;
  const installCmd = `polpo ink add ${pkg.source} --name ${pkg.name}`;
  const ghUrl = `https://github.com/${pkg.source}`;

  return (
    <div className="min-h-screen bg-white text-neutral-950">
      <div className="grain" />
      <Navbar />

      <section className="pt-24 pb-24 md:pt-32 md:pb-32">
        <div className="mx-auto max-w-4xl px-6">
          {/* Breadcrumb */}
          <Reveal>
            <Link to="/ink" className="inline-flex items-center gap-1.5 text-sm text-neutral-400 hover:text-neutral-700 transition mb-6">
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to registry
            </Link>
          </Reveal>

          {/* Header */}
          <Reveal delay={0.04}>
            <div className="flex items-start gap-4">
              <div className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border ${config.borderColor} ${config.bg}`}>
                <Icon className={`h-7 w-7 ${config.color}`} strokeWidth={1.5} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3 flex-wrap">
                  <h1 className="font-display text-3xl font-extrabold tracking-tight text-neutral-950">{pkg.name}</h1>
                  <span className={`rounded-full border px-2.5 py-0.5 font-mono text-xs font-medium ${config.borderColor} ${config.bg} ${config.color}`}>
                    {config.label}
                  </span>
                </div>
                <p className="mt-1.5 text-neutral-500">{pkg.description}</p>
              </div>
            </div>
          </Reveal>

          {/* Meta row */}
          <Reveal delay={0.08}>
            <div className="mt-6 flex flex-wrap items-center gap-4 text-sm text-neutral-500">
              {pkg.author && (
                <span className="flex items-center gap-1.5">
                  <User className="h-3.5 w-3.5" />
                  {pkg.author}
                </span>
              )}
              {pkg.version && (
                <span className="flex items-center gap-1.5">
                  <Tag className="h-3.5 w-3.5" />
                  v{pkg.version}
                </span>
              )}
              <ExtLink href={ghUrl} className="flex items-center gap-1.5 hover:text-neutral-700 transition">
                <GitHubIcon className="h-3.5 w-3.5" />
                {pkg.source}
                <ExternalLink className="h-3 w-3" />
              </ExtLink>
              {pkg.conventionPath && (
                <span className="flex items-center gap-1.5">
                  <FileCode className="h-3.5 w-3.5" />
                  <code className="font-mono text-xs">{pkg.conventionPath}</code>
                </span>
              )}
            </div>
          </Reveal>

          {/* Install command */}
          <Reveal delay={0.12}>
            <div className="mt-6">
              <CopyButton text={installCmd} />
            </div>
          </Reveal>

          {/* Content grid */}
          <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-[1fr_280px]">
            {/* Main content */}
            <div>
              {/* Dynamic package content — fetched from GitHub */}
              <PackageContent source={pkg.source} name={pkg.name} type={pkg.type} />

              {/* Install instructions */}
              <Reveal delay={0.22}>
                <div className="mt-8">
                  <h2 className="font-display text-lg font-bold text-neutral-900 mb-3">Installation</h2>
                  <div className="overflow-hidden rounded-xl border border-neutral-700/50 bg-[#1e1e1e]">
                    <div className="flex items-center gap-2 border-b border-neutral-700/50 px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                        <div className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                        <div className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
                      </div>
                      <span className="ml-2 font-mono text-xs text-neutral-500">terminal</span>
                    </div>
                    <div className="p-5 font-mono text-sm space-y-3">
                      <div className="flex items-start gap-3">
                        <span className="text-emerald-500 select-none">$</span>
                        <span className="text-neutral-200">{installCmd}</span>
                      </div>
                      <div className="text-neutral-500 text-xs">
                        # This will clone {pkg.source}, discover packages, and install them locally
                      </div>
                      {pkg.type === "playbook" && (
                        <>
                          <div className="border-t border-neutral-700/50 pt-3 flex items-start gap-3">
                            <span className="text-emerald-500 select-none">$</span>
                            <span className="text-neutral-200">polpo mission create --playbook {pkg.name}</span>
                          </div>
                          <div className="text-neutral-500 text-xs">
                            # Create a mission from this playbook
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </Reveal>
            </div>

            {/* Sidebar */}
            <div className="space-y-6">
              {/* Tags */}
              <Reveal delay={0.16}>
                <div>
                  <h3 className="font-mono text-xs uppercase tracking-wider text-neutral-400 mb-2">Tags</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {pkg.tags.map((tag) => (
                      <span key={tag} className="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-xs text-neutral-600">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              </Reveal>

              {/* Links */}
              <Reveal delay={0.2}>
                <div>
                  <h3 className="font-mono text-xs uppercase tracking-wider text-neutral-400 mb-2">Links</h3>
                  <div className="space-y-2">
                    <ExtLink href={ghUrl} className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900">
                      <GitHubIcon className="h-4 w-4" />
                      Source code
                      <ExternalLink className="h-3 w-3 ml-auto text-neutral-300" />
                    </ExtLink>
                    <ExtLink href="https://docs.polpo.sh/features/ink" className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900">
                      <BookOpen className="h-4 w-4" />
                      Ink documentation
                      <ExternalLink className="h-3 w-3 ml-auto text-neutral-300" />
                    </ExtLink>
                  </div>
                </div>
              </Reveal>

              {/* Security */}
              <Reveal delay={0.24}>
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="h-4 w-4 text-emerald-600" />
                    <span className="text-sm font-semibold text-emerald-800">Security scanned</span>
                  </div>
                  <p className="text-xs text-emerald-700/70 leading-relaxed">
                    Packages are scanned by an LLM judge on first install. Content is hashed (SHA-256) and verdicts are cached.
                  </p>
                </div>
              </Reveal>

              {/* Related packages from same source */}
              {related.length > 0 && (
                <Reveal delay={0.28}>
                  <div>
                    <h3 className="font-mono text-xs uppercase tracking-wider text-neutral-400 mb-2">
                      More from {pkg.source}
                    </h3>
                    <div className="space-y-2">
                      {related.slice(0, 5).map((r) => (
                        <RelatedRow key={r.name} pkg={r} />
                      ))}
                      {related.length > 5 && (
                        <Link to="/ink" className="block text-center text-xs text-neutral-400 hover:text-neutral-700 transition py-1">
                          +{related.length - 5} more
                        </Link>
                      )}
                    </div>
                  </div>
                </Reveal>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-neutral-200 bg-neutral-50 py-8">
        <div className="mx-auto max-w-5xl px-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/logo-text.svg" alt="Polpo" className="h-4" />
            <span className="text-xs text-neutral-400">Ink — Package Registry</span>
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
