import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion, useInView, AnimatePresence } from "motion/react";
import {
  Code2,
  Globe,
  Mail,
  FileText,
  Image,
  Search,
  Shield,
  BotMessageSquare,
  Zap,
  RefreshCw,
  Bell,
  CheckCircle2,
  Sparkles,
  ArrowRight,
  Copy,
  Check,
  Target,
  Loader2,
  Users,
  BarChart3,
  MessageSquare,
  BookOpen,
  Star,
  Scale,
  ShieldCheck,
  Play,
  Laptop,
  Server,
  Container,
  Smartphone,
  Package,
  type LucideIcon,
} from "lucide-react";

/* ── Discord icon (brand — not in Lucide) ─────────────────────────── */

function DiscordIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z" />
    </svg>
  );
}

/* ── GitHub icon (brand — not in Lucide) ──────────────────────────── */

function GitHubIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

/* ── External link helper ──────────────────────────────────────────── */

function ExtLink({
  href,
  className = "",
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}

/* ── Scroll-reveal ─────────────────────────────────────────────────── */

function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, y: 24 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/* ── Install bar ───────────────────────────────────────────────────── */

function InstallBar({ className = "" }: { className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText("npm install -g @polpo-ai/polpo");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={copy}
      className={`group inline-flex items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-5 py-3.5 font-mono text-sm transition hover:border-neutral-400 ${className}`}
    >
      <span className="text-neutral-400 select-none">$</span>
      <code className="text-neutral-900">npm install -g @polpo-ai/polpo</code>
      <AnimatePresence mode="wait">
        {copied ? (
          <motion.span
            key="check"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
          >
            <Check className="ml-2 h-4 w-4 text-emerald-500" />
          </motion.span>
        ) : (
          <motion.span
            key="copy"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
          >
            <Copy className="ml-2 h-4 w-4 text-neutral-400 transition group-hover:text-neutral-700" />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

/* ── Navbar ─────────────────────────────────────────────────────────── */

function Navbar() {
  return (
    <header className="fixed top-0 z-50 w-full border-b border-neutral-100 bg-white/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <Link to="/" className="flex items-center">
          <img src="/logo-text.svg" alt="Polpo" className="h-6" />
        </Link>
        <nav className="flex items-center gap-5">
          <Link
            to="/ink"
            className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3.5 py-1.5 text-sm font-medium text-indigo-700 transition hover:border-indigo-300 hover:bg-indigo-100"
          >
            <Package className="h-3.5 w-3.5" />
            Ink Hub
            <span className="rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] font-bold text-white leading-none">NEW</span>
          </Link>
          <ExtLink
            href="https://docs.polpo.sh"
            className="flex items-center gap-1.5 text-sm text-neutral-500 transition hover:text-neutral-950"
          >
            <BookOpen className="h-3.5 w-3.5" />
            Docs
          </ExtLink>
          <ExtLink
            href="https://discord.gg/xha8trjq"
            className="flex items-center gap-1.5 text-sm text-neutral-500 transition hover:text-neutral-950"
          >
            <DiscordIcon className="h-3.5 w-3.5" />
            Discord
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

/* ── Hero ───────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <section className="relative overflow-hidden pt-28 pb-24 md:pt-40 md:pb-32">
      {/* Mesh trama with bottom fade */}
      <div className="hero-mesh pointer-events-none absolute inset-0" style={{ maskImage: "linear-gradient(to bottom, black 40%, transparent 90%)", WebkitMaskImage: "linear-gradient(to bottom, black 40%, transparent 90%)" }} />
      {/* Radial glow — warm center */}
      <div className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 h-[700px] w-[900px] bg-[radial-gradient(ellipse,rgba(232,104,138,0.05)_0%,rgba(59,62,115,0.03)_40%,transparent_70%)]" />

      <div className="relative mx-auto max-w-3xl px-6 text-center">
        <Reveal>
          <ExtLink
            href="https://github.com/lumea-labs/polpo"
            className="mb-6 inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-4 py-1.5 font-mono text-xs tracking-wide text-neutral-500 transition hover:border-neutral-400 hover:text-neutral-900"
          >
            <motion.span
              animate={{ scale: [1, 1.2, 1] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            >
              <Star className="h-3.5 w-3.5 text-amber-400 fill-amber-400" />
            </motion.span>
            Star us on GitHub
          </ExtLink>
        </Reveal>

        <Reveal delay={0.06}>
          <p className="mb-6 font-mono text-xs uppercase tracking-[0.25em] text-neutral-400">Built for human freedom</p>
        </Reveal>

        <Reveal delay={0.12}>
          <h1 className="font-display text-5xl font-extrabold tracking-tight text-neutral-950 sm:text-6xl lg:text-7xl">
            Build your
            <br />
            <motion.span
              className="inline-block"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.4, ease: [0.22, 1, 0.36, 1] }}
            >
              AI company.
            </motion.span>
          </h1>
        </Reveal>

        <Reveal delay={0.2}>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-neutral-500">
             Spin up AI agent teams that plan, execute, and review their own
            work. Every output scored by LLM judges. Below threshold? The agent
            fixes it. Your laptop, your API keys, your rules.
          </p>
        </Reveal>

        <Reveal delay={0.28}>
          <div className="mt-8">
            <InstallBar />
          </div>
        </Reveal>

        <Reveal delay={0.36}>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <ExtLink
              href="https://docs.polpo.sh"
              className="inline-flex items-center gap-2 rounded-lg bg-neutral-950 px-6 py-3 text-sm font-semibold text-white transition hover:bg-neutral-800"
            >
              Get started <ArrowRight className="h-4 w-4" />
            </ExtLink>
            <ExtLink
              href="https://github.com/lumea-labs/polpo"
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-6 py-3 text-sm font-semibold text-neutral-700 transition hover:border-neutral-400 hover:text-neutral-950"
            >
              <GitHubIcon className="h-4 w-4" />
              GitHub
            </ExtLink>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ── Video section ─────────────────────────────────────────────────── */

function VideoSection() {
  return (
    <section className="pb-24 md:pb-32">
      <div className="mx-auto max-w-5xl px-6">
        <Reveal>
          <p className="mx-auto mb-8 max-w-2xl text-center text-neutral-500">
            4 monitors, 12 terminals, zero confidence anything actually works.<br />
            Stop babysitting AI agents — let Polpo manage them for you.
          </p>
        </Reveal>
        <Reveal delay={0.08}>
          <div className="relative overflow-hidden rounded-xl border border-neutral-200 bg-neutral-950 aspect-video shadow-2xl shadow-neutral-950/10">
            <video
              className="absolute inset-0 w-full h-full object-contain cursor-pointer"
              src="https://pub-3ebcd654a5c74a0ab00c87cbb7507f97.r2.dev/Polpo-Intro.mp4"
              autoPlay
              muted
              loop
              playsInline
              onClick={(e) => {
                const v = e.currentTarget;
                if (document.fullscreenElement) {
                  document.exitFullscreen();
                } else {
                  v.requestFullscreen();
                }
              }}
              title="Click for fullscreen"
            />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ── Comparison ────────────────────────────────────────────────────── */

function Comparison() {
  const rows = [
    {
      tool: "Claude Code / Cursor",
      get: "A developer",
      how: "One agent, one chat, one task. You drive.",
    },
    {
      tool: "OpenClaw",
      get: "An assistant",
      how: "Multiple agents, no quality checks. You hope it works.",
    },
    {
      tool: "Polpo",
      get: "A company",
      how: "A team with a manager that plans, delegates, reviews, retries, and reports back. You're the CEO.",
      highlight: true,
    },
  ];
  return (
    <section className="py-24 md:py-32">
      <div className="mx-auto max-w-3xl px-6">
        <Reveal>
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight text-neutral-950 sm:text-4xl">
            You don't need another coding assistant.
            <br />
            <span className="text-neutral-400">
              You need a team that runs without you.
            </span>
          </h2>
        </Reveal>
        <Reveal delay={0.12}>
          <div className="mt-12 overflow-hidden rounded-xl border border-neutral-200">
            <div className="grid grid-cols-[180px_140px_1fr] gap-4 border-b border-neutral-100 bg-neutral-50 px-6 py-3 font-mono text-xs uppercase tracking-wider text-neutral-400 max-md:hidden">
              <span />
              <span>What you get</span>
              <span>How it works</span>
            </div>
            {rows.map((r, i) => (
              <div
                key={i}
                className={`grid grid-cols-1 gap-1 border-b border-neutral-100 px-6 py-4 last:border-0 md:grid-cols-[180px_140px_1fr] md:gap-4 md:items-center ${
                  r.highlight
                    ? "bg-gradient-to-r from-rose-50 to-violet-50 border-l-2 border-l-rose-400"
                    : ""
                }`}
              >
                <span
                  className={`font-display text-sm font-bold ${r.highlight ? "text-neutral-950" : "text-neutral-900"}`}
                >
                  {r.tool}
                </span>
                <span
                  className={`text-sm font-semibold ${r.highlight ? "text-rose-600" : "text-neutral-600"}`}
                >
                  {r.get}
                </span>
                <span
                  className={`text-sm ${r.highlight ? "text-neutral-600" : "text-neutral-500"}`}
                >
                  {r.how}
                </span>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ── Mock: Agent Team Flow (SVG — multi-team) ────────────────────── */

function TeamFlow() {
  /* Two teams + orchestrator + review node */
  const teamA = [
    { name: "backend-dev", role: "Node.js & APIs", status: "active" as const },
    { name: "frontend-dev", role: "React & UI", status: "active" as const },
  ];
  const teamB = [
    { name: "researcher", role: "Web & docs", status: "idle" as const },
    { name: "writer", role: "Copy & content", status: "done" as const },
  ];

  const dot = { active: "#10b981", idle: "#a3a3a3", done: "#737373" };
  const fill = { active: "#ecfdf5", idle: "#ffffff", done: "#fafafa" };
  const border = { active: "#10b981", idle: "#d4d4d4", done: "#d4d4d4" };

  /* Coordinates (viewBox 800×440) */
  const orch = { x: 310, y: 20, w: 180, h: 60 };
  const teamABox = { x: 30, y: 140, w: 320, h: 150, label: "Engineering Team" };
  const teamBBox = { x: 450, y: 140, w: 320, h: 150, label: "Research Team" };
  const review = { x: 310, y: 360, w: 180, h: 56 };

  const agentW = 130, agentH = 50;

  function AgentRect({ a, ax, ay }: { a: { name: string; role: string; status: "active" | "idle" | "done" }; ax: number; ay: number }) {
    return (
      <g>
        <rect x={ax} y={ay} width={agentW} height={agentH} rx="6" fill={fill[a.status]} stroke={border[a.status]} strokeWidth="1.5" />
        <circle cx={ax + 14} cy={ay + 20} r="3.5" fill={dot[a.status]}>
          {a.status === "active" && <animate attributeName="opacity" values="1;0.4;1" dur="1.5s" repeatCount="indefinite" />}
        </circle>
        <text x={ax + 26} y={ay + 23} fill="#171717" fontSize="11" fontWeight="700" fontFamily="DM Mono, monospace">{a.name}</text>
        <text x={ax + 14} y={ay + 40} fill="#737373" fontSize="9" fontFamily="DM Sans, sans-serif">{a.role}</text>
      </g>
    );
  }

  return (
    <section className="relative py-24 md:py-32 overflow-hidden">
      <div className="dot-grid pointer-events-none absolute inset-0 opacity-40" />

      <div className="relative mx-auto max-w-5xl px-6">
        <Reveal>
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight text-neutral-950 sm:text-4xl">
            Multiple teams,{" "}
            <span className="text-neutral-400">one orchestrator.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-center text-neutral-500">
            Define specialized teams — engineering, research, content, ops — each
            with their own agents, credentials, and tools. Polpo coordinates
            across all of them.
          </p>
        </Reveal>

        <Reveal delay={0.12}>
          <div className="relative mt-14 overflow-hidden rounded-xl border border-neutral-200 bg-white">
            <svg viewBox="0 0 800 440" className="w-full" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <marker id="arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                  <polygon points="0 0, 8 3, 0 6" fill="#a3a3a3" />
                </marker>
              </defs>

              {/* Edges: orchestrator → team boxes */}
              <path d={`M${orch.x + orch.w / 2},${orch.y + orch.h} L${teamABox.x + teamABox.w / 2},${teamABox.y}`} stroke="#d4d4d4" strokeWidth="1.5" className="flow-line" />
              <path d={`M${orch.x + orch.w / 2},${orch.y + orch.h} L${teamBBox.x + teamBBox.w / 2},${teamBBox.y}`} stroke="#d4d4d4" strokeWidth="1.5" className="flow-line flow-line-delay-1" />

              {/* Edges: team boxes → review */}
              <path d={`M${teamABox.x + teamABox.w / 2},${teamABox.y + teamABox.h} L${review.x + review.w / 2},${review.y}`} stroke="#d4d4d4" strokeWidth="1" strokeDasharray="4 4" className="flow-line flow-line-delay-2" />
              <path d={`M${teamBBox.x + teamBBox.w / 2},${teamBBox.y + teamBBox.h} L${review.x + review.w / 2},${review.y}`} stroke="#d4d4d4" strokeWidth="1" strokeDasharray="4 4" className="flow-line flow-line-delay-3" />

              {/* Edge: review → orchestrator (feedback loop) */}
              <path d={`M${review.x + review.w + 10},${review.y + review.h / 2} C${800 - 40},${review.y + review.h / 2} ${800 - 40},${orch.y + orch.h / 2} ${orch.x + orch.w + 10},${orch.y + orch.h / 2}`} stroke="#d4d4d4" strokeWidth="1.5" strokeDasharray="4 4" markerEnd="url(#arrow)" className="flow-line flow-line-delay-1" />

              {/* Orchestrator */}
              <rect x={orch.x} y={orch.y} width={orch.w} height={orch.h} rx="10" fill="#0a0a0a" />
              <text x={orch.x + orch.w / 2} y={orch.y + 26} textAnchor="middle" fill="white" fontSize="14" fontWeight="700" fontFamily="Bricolage Grotesque, sans-serif">Polpo Orchestrator</text>
              <text x={orch.x + orch.w / 2} y={orch.y + 44} textAnchor="middle" fill="#a3a3a3" fontSize="10" fontFamily="DM Sans, sans-serif">Plan · Delegate · Review · Report</text>

              {/* Team A box */}
              <rect x={teamABox.x} y={teamABox.y} width={teamABox.w} height={teamABox.h} rx="10" fill="none" stroke="#e5e5e5" strokeWidth="1.5" strokeDasharray="6 3" />
              <text x={teamABox.x + 12} y={teamABox.y + 20} fill="#a3a3a3" fontSize="10" fontWeight="600" fontFamily="DM Mono, monospace">{teamABox.label}</text>
              {teamA.map((a, i) => (
                <AgentRect key={i} a={a} ax={teamABox.x + 16 + i * (agentW + 20)} ay={teamABox.y + 36} />
              ))}
              {/* Credential badge */}
              <rect x={teamABox.x + 16} y={teamABox.y + 100} width={teamABox.w - 32} height={28} rx="6" fill="#fafafa" stroke="#e5e5e5" strokeWidth="1" />
              <text x={teamABox.x + 32} y={teamABox.y + 118} fill="#a3a3a3" fontSize="9" fontFamily="DM Mono, monospace">vault: github_token, db_password, aws_key</text>

              {/* Team B box */}
              <rect x={teamBBox.x} y={teamBBox.y} width={teamBBox.w} height={teamBBox.h} rx="10" fill="none" stroke="#e5e5e5" strokeWidth="1.5" strokeDasharray="6 3" />
              <text x={teamBBox.x + 12} y={teamBBox.y + 20} fill="#a3a3a3" fontSize="10" fontWeight="600" fontFamily="DM Mono, monospace">{teamBBox.label}</text>
              {teamB.map((a, i) => (
                <AgentRect key={i} a={a} ax={teamBBox.x + 16 + i * (agentW + 20)} ay={teamBBox.y + 36} />
              ))}
              <rect x={teamBBox.x + 16} y={teamBBox.y + 100} width={teamBBox.w - 32} height={28} rx="6" fill="#fafafa" stroke="#e5e5e5" strokeWidth="1" />
              <text x={teamBBox.x + 32} y={teamBBox.y + 118} fill="#a3a3a3" fontSize="9" fontFamily="DM Mono, monospace">vault: serp_api, notion_token</text>

              {/* Review node */}
              <rect x={review.x} y={review.y} width={review.w} height={review.h} rx="10" fill="#fafafa" stroke="#e5e5e5" strokeWidth="1.5" strokeDasharray="4 2" />
              <text x={review.x + review.w / 2} y={review.y + 24} textAnchor="middle" fill="#171717" fontSize="12" fontWeight="700" fontFamily="DM Mono, monospace">G-Eval Review</text>
              <text x={review.x + review.w / 2} y={review.y + 42} textAnchor="middle" fill="#737373" fontSize="10" fontFamily="DM Sans, sans-serif">3 judges · 4 dimensions · retry loop</text>

              {/* Legend */}
              <g transform="translate(16, 420)">
                <circle cx="6" cy="6" r="3.5" fill="#10b981" />
                <text x="16" y="10" fill="#737373" fontSize="9" fontFamily="DM Sans, sans-serif">Active</text>
                <circle cx="66" cy="6" r="3.5" fill="#a3a3a3" />
                <text x="76" y="10" fill="#737373" fontSize="9" fontFamily="DM Sans, sans-serif">Idle</text>
                <circle cx="116" cy="6" r="3.5" fill="#737373" />
                <text x="126" y="10" fill="#737373" fontSize="9" fontFamily="DM Sans, sans-serif">Done</text>
              </g>
            </svg>

            {/* Live activity feed */}
            <div className="border-t border-neutral-100 bg-neutral-50 p-5 space-y-2">
              <p className="font-mono text-xs uppercase tracking-wider text-neutral-400">Live activity</p>
              {[
                { agent: "backend-dev", task: "Set up Express routes with JWT auth", status: "in_progress" },
                { agent: "frontend-dev", task: "Create React dashboard components", status: "in_progress" },
                { agent: "writer", task: "Draft API documentation", status: "done", score: "4.2 / 5" },
                { agent: "polpo", task: "Score below 3.0 on auth middleware — retrying backend-dev", status: "retry" },
              ].map((t, i) => (
                <div key={i} className="flex items-center gap-3 rounded-md bg-white px-3 py-2 text-sm">
                  {t.status === "in_progress" && <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-500" />}
                  {t.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
                  {t.status === "retry" && <RefreshCw className="h-3.5 w-3.5 text-amber-500" />}
                  <span className="font-mono text-xs font-medium text-neutral-600">{t.agent}</span>
                  <span className="text-neutral-500">{t.task}</span>
                  {t.score && (
                    <span className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">{t.score}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ── Quality Assurance — G-Eval ──────────────────────────────────── */

function QualitySection() {
  const dimensions = [
    { label: "Correctness", score: 4.6, color: "bg-emerald-500" },
    { label: "Completeness", score: 4.2, color: "bg-sky-500" },
    { label: "Code Quality", score: 4.8, color: "bg-violet-500" },
    { label: "Edge Cases", score: 3.9, color: "bg-amber-500" },
  ];

  const globalScore = 4.4;

  return (
    <section className="relative border-y border-neutral-100 py-24 md:py-32 overflow-hidden">
      <div className="hero-mesh pointer-events-none absolute inset-0 opacity-60" />

      <div className="relative mx-auto max-w-4xl px-6">
        <Reveal>
          <div className="flex items-center justify-center gap-2 mb-4">
            <Scale className="h-5 w-5 text-violet-400" />
            <span className="font-mono text-xs uppercase tracking-wider text-neutral-400">G-Eval Review System</span>
          </div>
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight text-neutral-950 sm:text-4xl">
            Every task judged.{" "}
            <span className="text-neutral-400">Nothing ships broken.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-neutral-500">
            Like UFC judges, but for your agents' work. You define the scoring
            criteria for each task. 3 independent LLM reviewers evaluate the
            output in parallel. Median wins, outliers get cut. Below threshold?
            The agent goes back to work.
          </p>
        </Reveal>

        {/* How it works — 3 step flow */}
        <Reveal delay={0.08}>
          <div className="mt-14 flex flex-col items-center gap-4 sm:flex-row sm:gap-0 sm:justify-center">
            {[
              { step: "1", label: "You define criteria", sub: "Per task: what to check, what score to beat" },
              { step: "2", label: "3 judges evaluate", sub: "Each explores output with real tools, scores per dimension" },
              { step: "3", label: "Pass or retry", sub: "Median score vs threshold. Fail? Agent gets feedback and retries" },
            ].map((s, i) => (
              <div key={i} className="flex items-center">
                <div className="flex flex-col items-center text-center w-52">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-950 font-display text-sm font-bold text-white mb-2">
                    {s.step}
                  </div>
                  <span className="font-display text-sm font-bold text-neutral-900">{s.label}</span>
                  <span className="mt-1 text-xs text-neutral-500 leading-snug">{s.sub}</span>
                </div>
                {i < 2 && <ArrowRight className="hidden sm:block h-4 w-4 text-neutral-300 mx-4 shrink-0" />}
              </div>
            ))}
          </div>
        </Reveal>

        {/* Score card mock */}
        <Reveal delay={0.16}>
          <div className="mt-12 mx-auto max-w-md rounded-xl border border-neutral-200 bg-white overflow-hidden shadow-sm">
            <div className="border-b border-neutral-100 bg-gradient-to-r from-violet-50 to-rose-50 px-5 py-3 flex items-center justify-between">
              <div>
                <span className="font-mono text-xs uppercase tracking-wider text-neutral-500">Task: </span>
                <span className="font-mono text-xs text-neutral-700">Set up Express routes</span>
              </div>
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-700">PASS</span>
            </div>
            <div className="p-5">
              <div className="flex items-center justify-between mb-5">
                <span className="text-sm text-neutral-500">Global score</span>
                <span className="font-display text-3xl font-extrabold text-neutral-950">{globalScore}<span className="text-lg text-neutral-400"> / 5</span></span>
              </div>
              <div className="space-y-3">
                {dimensions.map((d, i) => (
                  <div key={i}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-neutral-600">{d.label}</span>
                      <span className="font-mono text-xs text-neutral-500">{d.score}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-neutral-100 overflow-hidden">
                      <motion.div
                        className={`h-full rounded-full ${d.color}`}
                        initial={{ width: 0 }}
                        whileInView={{ width: `${(d.score / 5) * 100}%` }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.8, delay: i * 0.1, ease: [0.22, 1, 0.36, 1] }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 pt-4 border-t border-neutral-100 flex items-center gap-2 text-xs text-neutral-400">
                <span className="font-mono">3 judges</span>
                <span>&middot;</span>
                <span className="font-mono">median</span>
                <span>&middot;</span>
                <span className="font-mono">threshold 3.0</span>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ── Capabilities ──────────────────────────────────────────────────── */

function Capabilities() {
  const caps = [
    { icon: Code2, title: "Code", desc: "Read, write, edit, run shell commands across your project." },
    { icon: Globe, title: "Browse the web", desc: "Navigate, click, fill forms, screenshot. Persistent logins." },
    { icon: Mail, title: "Email", desc: "Send, read, search inbox. SMTP + IMAP with attachments." },
    { icon: FileText, title: "Documents", desc: "Generate PDFs, Word docs, Excel spreadsheets, CSVs." },
    { icon: Image, title: "Images & video", desc: "Generate images, videos, text-to-speech in 400+ voices." },
    { icon: Search, title: "Search", desc: "Semantic web search. Find competitors, research, discover." },
    { icon: Shield, title: "Secure vault", desc: "Per-agent encrypted credentials. AES-256. Zero leaks." },
    { icon: Sparkles, title: "Skills", desc: "Agents learn and evolve. Install, create, or let Polpo figure it out." },
  ];
  return (
    <section className="bg-neutral-50/50 py-24 md:py-32">
      <div className="mx-auto max-w-4xl px-6">
        <Reveal>
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight text-neutral-950 sm:text-4xl">
            Your agents aren't chatbots.
            <br />
            <span className="text-neutral-400">They're workers with real tools.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-center text-neutral-500">
            Each agent is a full worker — with its own credentials, tools, skills,
            and role. They execute tasks, access APIs, generate files, and operate
            autonomously within the boundaries you set.
          </p>
        </Reveal>
        <div className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-neutral-200 bg-neutral-200 sm:grid-cols-2 lg:grid-cols-4">
          {caps.map((c, i) => {
            const Icon = c.icon;
            const accentColors = [
              "text-rose-400", "text-sky-400", "text-amber-400", "text-violet-400",
              "text-emerald-400", "text-orange-400", "text-indigo-400", "text-pink-400",
            ];
            return (
              <Reveal key={i} delay={i * 0.04} className="bg-white p-6">
                <Icon className={`mb-3 h-5 w-5 ${accentColors[i]}`} strokeWidth={1.5} />
                <h3 className="font-display text-sm font-bold text-neutral-900">{c.title}</h3>
                <p className="mt-1 text-sm leading-snug text-neutral-500">{c.desc}</p>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ── Feature showcase ─────────────────────────────────────────────── */

function FeatureShowcase() {
  const features: { icon: LucideIcon; title: string; desc: string; link: string; linkLabel: string; accent: string }[] = [
    { icon: Target, title: "Missions & Plans", desc: "Define complex goals, Polpo breaks them into tasks with dependencies and agent assignments.", link: "https://docs.polpo.sh/concepts/missions", linkLabel: "Mission guide", accent: "text-rose-500 bg-rose-50" },
    { icon: BarChart3, title: "LLM-as-Judge Review", desc: "3 parallel judges score every task across 4 dimensions. Below threshold? Automatic retry with targeted fixes.", link: "https://docs.polpo.sh/features/review", linkLabel: "Review pipeline", accent: "text-violet-500 bg-violet-50" },
    { icon: Users, title: "Teams & Roles", desc: "Define specialized agents with roles, skills, and tool access. Assign them to teams.", link: "https://docs.polpo.sh/concepts/teams", linkLabel: "Team setup", accent: "text-sky-500 bg-sky-50" },
    { icon: Bell, title: "Notifications", desc: "Slack, Telegram, email, webhooks. Get pinged on approvals, completions, and failures.", link: "https://docs.polpo.sh/features/notifications", linkLabel: "Notification channels", accent: "text-amber-500 bg-amber-50" },
    { icon: ShieldCheck, title: "Approval Gates", desc: "Human-in-the-loop checkpoints. Block critical tasks until you review and approve.", link: "https://docs.polpo.sh/features/approval-gates", linkLabel: "Approval setup", accent: "text-emerald-500 bg-emerald-50" },
    { icon: MessageSquare, title: "Chat Interface", desc: "Talk to Polpo like a project manager. Describe what you need, it handles the rest.", link: "https://docs.polpo.sh/usage/tui", linkLabel: "Chat & TUI guide", accent: "text-indigo-500 bg-indigo-50" },
    { icon: Sparkles, title: "Skills System", desc: "Agents learn through reusable skills. Install from community, create custom, or let Polpo evolve them.", link: "https://docs.polpo.sh/features/skills", linkLabel: "Skills guide", accent: "text-pink-500 bg-pink-50" },
    { icon: RefreshCw, title: "Scheduling", desc: "Run missions on a cron schedule. Automate recurring workflows while you sleep.", link: "https://docs.polpo.sh/features/scheduling", linkLabel: "Scheduling guide", accent: "text-orange-500 bg-orange-50" },
  ];

  return (
    <section className="border-y border-neutral-100 bg-neutral-50/50 py-24 md:py-32">
      <div className="mx-auto max-w-5xl px-6">
        <Reveal>
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight text-neutral-950 sm:text-4xl">
            Everything you need.{" "}
            <span className="text-neutral-400">Nothing you don't.</span>
          </h2>
        </Reveal>
        <div className="mt-14 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f, i) => {
            const Icon = f.icon;
            return (
              <Reveal key={i} delay={i * 0.04}>
                <div className="group flex h-full flex-col rounded-xl border border-neutral-200 bg-white p-5 transition hover:border-neutral-300 hover:shadow-sm">
                  <div className={`mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg ${f.accent.split(" ")[1]}`}>
                    <Icon className={`h-4.5 w-4.5 ${f.accent.split(" ")[0]}`} strokeWidth={1.5} />
                  </div>
                  <h3 className="font-display text-sm font-bold text-neutral-900">{f.title}</h3>
                  <p className="mt-1.5 flex-1 text-sm leading-snug text-neutral-500">{f.desc}</p>
                  <ExtLink
                    href={f.link}
                    className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-neutral-400 transition group-hover:text-neutral-900"
                  >
                    {f.linkLabel} <ArrowRight className="h-3 w-3" />
                  </ExtLink>
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ── Deploy options ───────────────────────────────────────────────── */

function DeployOptions() {
  const options: { icon: LucideIcon; title: string; desc: string; link: string }[] = [
    { icon: Laptop, title: "Laptop", desc: "npm install, done.", link: "https://docs.polpo.sh/install" },
    { icon: Server, title: "VPS / Cloud", desc: "Hetzner, AWS, Railway.", link: "https://docs.polpo.sh/install/hetzner" },
    { icon: Container, title: "Docker", desc: "One-line container.", link: "https://docs.polpo.sh/install#docker" },
    { icon: Smartphone, title: "Mobile", desc: "PWA, monitor anywhere.", link: "https://docs.polpo.sh/install" },
  ];
  return (
    <section className="py-24 md:py-32">
      <div className="mx-auto max-w-4xl px-6">
        <Reveal>
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight text-neutral-950 sm:text-4xl">
            Deploy <span className="text-neutral-400">anywhere.</span>
          </h2>
        </Reveal>
        <div className="mt-12 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {options.map((o, i) => {
            const Icon = o.icon;
            return (
              <Reveal key={i} delay={i * 0.05}>
                <ExtLink
                  href={o.link}
                  className="group flex flex-col items-center rounded-xl border border-neutral-200 bg-white p-6 text-center transition hover:border-neutral-300 hover:shadow-sm"
                >
                  <Icon className="mb-3 h-6 w-6 text-neutral-400 transition group-hover:text-neutral-900" strokeWidth={1.5} />
                  <span className="font-display text-sm font-bold text-neutral-900">{o.title}</span>
                  <span className="mt-1 text-xs text-neutral-500">{o.desc}</span>
                </ExtLink>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ── How it works ─────────────────────────────────────────────────── */

function HowItWorks() {
  const steps = [
    { cmd: "polpo init", note: "Initialize your project" },
    { cmd: 'polpo mission create "Close $1M in revenue this month"', note: "Describe what you need" },
  ];
  return (
    <section className="py-24 md:py-32">
      <div className="mx-auto max-w-4xl px-6">
        <Reveal>
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight text-neutral-950 sm:text-4xl">
            Two commands.{" "}
            <span className="text-neutral-400">That's it.</span>
          </h2>
        </Reveal>
        <Reveal delay={0.12}>
          <div className="mt-12 overflow-hidden rounded-2xl border border-neutral-700/50 bg-[#1e1e1e] shadow-2xl">
            {/* macOS title bar */}
            <div className="flex items-center gap-2 border-b border-neutral-700/50 px-4 py-3">
              <div className="flex items-center gap-1.5">
                <div className="h-3 w-3 rounded-full bg-[#ff5f57]" />
                <div className="h-3 w-3 rounded-full bg-[#febc2e]" />
                <div className="h-3 w-3 rounded-full bg-[#28c840]" />
              </div>
              <span className="ml-3 font-mono text-xs text-neutral-500">polpo — zsh — 80x24</span>
            </div>
            <div className="space-y-3 p-6 md:p-8 font-mono text-sm md:text-base leading-relaxed">
              {steps.map((s, i) => (
                <div key={i} className="flex items-start gap-3">
                  <span className="select-none text-emerald-500">$</span>
                  <span className="text-neutral-100">{s.cmd}</span>
                  <span className="ml-auto hidden text-neutral-600 sm:inline"># {s.note}</span>
                </div>
              ))}
              <div className="mt-5 flex items-start gap-3 border-t border-neutral-700/50 pt-5">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                <span className="text-neutral-400">
                  Mission complete. 4 tasks done, 0 failed. Report sent to Telegram.
                </span>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ── Differentiators ──────────────────────────────────────────────── */

function Differentiators() {
  const items = [
    { icon: BotMessageSquare, label: "Autonomous", text: "Builds missions, picks agents, works through queued tasks 24/7. Walk away." },
    { icon: CheckCircle2, label: "Reliable", text: "Every task scored by 3 LLM judges across 4 dimensions. Below threshold? The agent fixes it. You get results, not retries." },
    { icon: Zap, label: "Crash-proof", text: "Detached processes. Kill Polpo, reboot, lose connection — picks up where it left off." },
    { icon: Bell, label: "Proactive", text: "Reaches you on Slack, Telegram, email, webhooks. You decide when and how." },
    { icon: RefreshCw, label: "Playbooks", text: "Define a mission once, run it forever. Schedule it on cron, iterate on it. Your AI company gets better over time." },
    { icon: ShieldCheck, label: "Side-effect protection", text: "Flags irreversible actions (emails, API calls, deployments) for human approval before re-execution." },
  ];
  return (
    <section className="relative border-t border-neutral-100 bg-neutral-50/50 py-24 md:py-32 overflow-hidden">
      <div className="relative mx-auto max-w-2xl px-6">
        <Reveal>
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight text-neutral-950 sm:text-4xl">
            Agents that <span className="text-neutral-400">learn and evolve.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-center text-neutral-500">
            Polpo gets smarter over time. Skills, playbooks, and agent memory
            compound — your AI company improves with every run.
          </p>
        </Reveal>
        <div className="mt-12 space-y-1">
          {items.map((d, i) => {
            const Icon = d.icon;
            return (
              <Reveal key={i} delay={i * 0.06}>
                <div className="flex items-start gap-4 rounded-lg px-5 py-4 transition hover:bg-white">
                  <Icon className="mt-0.5 h-5 w-5 shrink-0 text-neutral-400" strokeWidth={1.5} />
                  <div>
                    <span className="font-display text-sm font-bold text-neutral-900">{d.label}</span>
                    <span className="ml-2 text-sm text-neutral-500">{d.text}</span>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ── CTA ──────────────────────────────────────────────────────────── */

function CTA() {
  return (
    <section className="relative py-24 text-center md:py-32 overflow-hidden">
      <div className="dot-grid pointer-events-none absolute inset-0 opacity-40" />
      <div className="relative mx-auto max-w-2xl px-6">
        <Reveal>
          <h2 className="font-display text-3xl font-extrabold tracking-tight text-neutral-950 sm:text-4xl">
            Ready to build your AI company?
          </h2>
        </Reveal>
        <Reveal delay={0.08}>
          <div className="mt-8">
            <InstallBar />
          </div>
        </Reveal>
        <Reveal delay={0.16}>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <ExtLink
              href="https://docs.polpo.sh"
              className="inline-flex items-center gap-2 rounded-lg bg-neutral-950 px-6 py-3 text-sm font-semibold text-white transition hover:bg-neutral-800"
            >
              Get started <ArrowRight className="h-4 w-4" />
            </ExtLink>
            <ExtLink
              href="https://github.com/lumea-labs/polpo"
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-6 py-3 text-sm font-semibold text-neutral-700 transition hover:border-neutral-400"
            >
              <GitHubIcon className="h-4 w-4" />
              GitHub
            </ExtLink>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ── Footer ───────────────────────────────────────────────────────── */

function Footer() {
  return (
    <footer className="border-t border-neutral-200 bg-neutral-50 py-10">
      <div className="mx-auto max-w-5xl px-6">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div>
            <img src="/logo-text.svg" alt="Polpo" className="h-5" />
            <p className="mt-1 text-sm text-neutral-500">Open-source orchestration and mission control for AI agent teams.</p>
          </div>

          <div className="flex gap-16">
            <div>
              <p className="font-mono text-xs uppercase tracking-wider text-neutral-400 mb-3">Resources</p>
              <nav className="flex flex-col gap-2">
                <ExtLink href="https://docs.polpo.sh" className="text-sm text-neutral-600 hover:text-neutral-950 transition">Documentation</ExtLink>
                <ExtLink href="https://docs.polpo.sh/install" className="text-sm text-neutral-600 hover:text-neutral-950 transition">Install guide</ExtLink>
                <ExtLink href="https://docs.polpo.sh/concepts/missions" className="text-sm text-neutral-600 hover:text-neutral-950 transition">Missions</ExtLink>
                <ExtLink href="https://docs.polpo.sh/features/review" className="text-sm text-neutral-600 hover:text-neutral-950 transition">Review pipeline</ExtLink>
              </nav>
            </div>
            <div>
              <p className="font-mono text-xs uppercase tracking-wider text-neutral-400 mb-3">Community</p>
              <nav className="flex flex-col gap-2">
                <ExtLink href="https://github.com/lumea-labs/polpo" className="text-sm text-neutral-600 hover:text-neutral-950 transition flex items-center gap-1.5">
                  <GitHubIcon className="h-3.5 w-3.5" /> GitHub
                </ExtLink>
                <ExtLink href="https://www.npmjs.com/package/@polpo-ai/polpo" className="text-sm text-neutral-600 hover:text-neutral-950 transition">npm</ExtLink>
                <ExtLink href="https://github.com/lumea-labs/polpo/issues" className="text-sm text-neutral-600 hover:text-neutral-950 transition">Issues</ExtLink>
                <ExtLink href="https://github.com/lumea-labs/polpo/blob/main/CONTRIBUTING.md" className="text-sm text-neutral-600 hover:text-neutral-950 transition">Contributing</ExtLink>
                <ExtLink href="https://discord.gg/xha8trjq" className="text-sm text-neutral-600 hover:text-neutral-950 transition">Discord</ExtLink>
              </nav>
            </div>
          </div>
        </div>

        <div className="mt-8 flex items-center justify-between border-t border-neutral-200 pt-6">
          <span className="text-xs text-neutral-400">MIT License</span>
          <ExtLink href="https://x.com/alessio_micali" className="text-xs text-neutral-400 hover:text-neutral-600 transition">
            @alessio_micali
          </ExtLink>
        </div>
      </div>
    </footer>
  );
}

/* ── App ───────────────────────────────────────────────────────────── */

export function App() {
  return (
    <div className="min-h-screen bg-white text-neutral-950">
      <div className="grain" />
      <Navbar />
      <Hero />
      <VideoSection />
      <Comparison />
      <TeamFlow />
      <QualitySection />
      <Capabilities />
      <FeatureShowcase />
      <HowItWorks />
      <Differentiators />
      <DeployOptions />
      <CTA />
      <Footer />
    </div>
  );
}
