import { useRef, type ReactNode } from "react";
import { motion, useInView } from "motion/react";
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
  Terminal,
  Bot,
  Target,
  Loader2,
  Clock,
  Users,
  BarChart3,
  MessageSquare,
  Rocket,
  BookOpen,
  Star,
  Scale,
  AlertTriangle,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

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
  const copy = () => {
    navigator.clipboard.writeText("npm install -g @polpo-ai/polpo");
    const el = document.getElementById("copy-toast");
    if (el) {
      el.textContent = "Copied!";
      setTimeout(() => (el.textContent = ""), 1500);
    }
  };
  return (
    <button
      onClick={copy}
      className={`group inline-flex items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-5 py-3.5 font-mono text-sm transition hover:border-neutral-400 ${className}`}
    >
      <span className="text-neutral-400 select-none">$</span>
      <code className="text-neutral-900">npm install -g @polpo-ai/polpo</code>
      <Copy className="ml-2 h-4 w-4 text-neutral-400 transition group-hover:text-neutral-700" />
      <span
        id="copy-toast"
        className="text-xs text-neutral-500 min-w-[3rem]"
      />
    </button>
  );
}

/* ── Navbar ─────────────────────────────────────────────────────────── */

function Navbar() {
  return (
    <header className="fixed top-0 z-50 w-full border-b border-neutral-100 bg-white/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <a href="/" className="flex items-center gap-2">
          <span className="font-display text-lg font-extrabold tracking-tight text-neutral-950">
            Polpo
          </span>
        </a>
        <nav className="flex items-center gap-5">
          <a
            href="https://docs.polpo.sh"
            className="flex items-center gap-1.5 text-sm text-neutral-500 transition hover:text-neutral-950"
          >
            <BookOpen className="h-3.5 w-3.5" />
            Docs
          </a>
          <a
            href="https://github.com/lumea-labs/polpo"
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 transition hover:border-neutral-400 hover:text-neutral-950"
          >
            <GitHubIcon className="h-4 w-4" />
            <Star className="h-3 w-3" />
            Star
          </a>
        </nav>
      </div>
    </header>
  );
}

/* ── Sections ──────────────────────────────────────────────────────── */

function Hero() {
  return (
    <section className="relative overflow-hidden pt-32 pb-24 md:pt-44 md:pb-32">
      {/* Dot grid background */}
      <div className="dot-grid pointer-events-none absolute inset-0 opacity-60" />

      <div className="relative mx-auto max-w-3xl px-6 text-center">
        <Reveal>
          <p className="mb-6 inline-block rounded-full border border-neutral-200 bg-white px-4 py-1.5 font-mono text-xs tracking-wide text-neutral-500">
            Open source &middot; MIT licensed
          </p>
        </Reveal>
        <Reveal delay={0.08}>
          <h1 className="font-display text-5xl font-extrabold tracking-tight text-neutral-950 sm:text-6xl lg:text-7xl">
            Build your
            <br />
            AI company.
          </h1>
        </Reveal>
        <Reveal delay={0.16}>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-neutral-500">
            Assemble AI agent teams that plan, execute, and review their own
            work. Every output scored by LLM judges. Below threshold? The agent
            fixes it. You're the CEO.
          </p>
        </Reveal>
        <Reveal delay={0.24}>
          <div className="mt-8">
            <InstallBar />
          </div>
        </Reveal>
        <Reveal delay={0.32}>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <a
              href="https://docs.polpo.sh"
              className="inline-flex items-center gap-2 rounded-lg bg-neutral-950 px-6 py-3 text-sm font-semibold text-white transition hover:bg-neutral-800"
            >
              Get started <ArrowRight className="h-4 w-4" />
            </a>
            <a
              href="https://github.com/lumea-labs/polpo"
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-6 py-3 text-sm font-semibold text-neutral-700 transition hover:border-neutral-400 hover:text-neutral-950"
            >
              <GitHubIcon className="h-4 w-4" />
              GitHub
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

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
            {/* Header */}
            <div className="grid grid-cols-[180px_140px_1fr] gap-4 border-b border-neutral-100 bg-neutral-50 px-6 py-3 font-mono text-xs uppercase tracking-wider text-neutral-400 max-md:hidden">
              <span />
              <span>What you get</span>
              <span>How it works</span>
            </div>
            {rows.map((r, i) => (
              <div
                key={i}
                className={`grid grid-cols-1 gap-1 border-b border-neutral-100 px-6 py-4 last:border-0 md:grid-cols-[180px_140px_1fr] md:gap-4 md:items-center ${
                  r.highlight ? "bg-neutral-950 text-white" : ""
                }`}
              >
                <span
                  className={`font-display text-sm font-bold ${r.highlight ? "text-white" : "text-neutral-900"}`}
                >
                  {r.tool}
                </span>
                <span
                  className={`text-sm font-semibold ${r.highlight ? "text-neutral-300" : "text-neutral-600"}`}
                >
                  {r.get}
                </span>
                <span
                  className={`text-sm ${r.highlight ? "text-neutral-400" : "text-neutral-500"}`}
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

/* ── Mock: Agent Team Flow (React-Flow style with SVG edges) ─────── */

function TeamFlow() {
  /* Layout positions for nodes (relative to SVG viewBox 800x520) */
  const orchestrator = { x: 320, y: 30, w: 160, h: 64 };
  const reviewNode = { x: 320, y: 200, w: 160, h: 64 };

  const agents = [
    { name: "backend-dev", role: "Node.js & APIs", status: "active" as const, x: 40, y: 200 },
    { name: "frontend-dev", role: "React & UI", status: "active" as const, x: 200, y: 200 },
    { name: "researcher", role: "Web & docs", status: "idle" as const, x: 520, y: 200 },
    { name: "reviewer", role: "QA & review", status: "done" as const, x: 680, y: 200 },
  ];

  const statusColors = {
    active: { border: "#10b981", bg: "#ecfdf5", dot: "#10b981" },
    idle: { border: "#d4d4d4", bg: "#ffffff", dot: "#a3a3a3" },
    done: { border: "#d4d4d4", bg: "#fafafa", dot: "#737373" },
  };

  return (
    <section className="relative py-24 md:py-32 overflow-hidden">
      {/* Subtle cross-hatch background */}
      <div className="dot-grid pointer-events-none absolute inset-0 opacity-40" />

      <div className="relative mx-auto max-w-5xl px-6">
        <Reveal>
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight text-neutral-950 sm:text-4xl">
            Your AI team,{" "}
            <span className="text-neutral-400">orchestrated.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-center text-neutral-500">
            Polpo acts as the manager. It plans the work, delegates to
            specialized agents, scores every output with LLM judges, and retries
            what doesn't meet the bar.
          </p>
        </Reveal>

        <Reveal delay={0.12}>
          <div className="relative mt-14 overflow-hidden rounded-xl border border-neutral-200 bg-white">
            {/* SVG Flow diagram */}
            <svg
              viewBox="0 0 800 340"
              className="w-full"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              {/* ── Edges from orchestrator to each agent ── */}
              {agents.map((a, i) => {
                const startX = orchestrator.x + orchestrator.w / 2;
                const startY = orchestrator.y + orchestrator.h;
                const endX = a.x + 70;
                const endY = a.y;
                const midY = (startY + endY) / 2;
                return (
                  <path
                    key={i}
                    d={`M${startX},${startY} C${startX},${midY} ${endX},${midY} ${endX},${endY}`}
                    stroke="#d4d4d4"
                    strokeWidth="1.5"
                    strokeDasharray={a.status === "idle" ? "4 4" : undefined}
                    className={`flow-line flow-line-delay-${i}`}
                  />
                );
              })}

              {/* ── Edge from review node back to orchestrator ── */}
              <path
                d={`M${reviewNode.x + reviewNode.w + 10},${reviewNode.y + reviewNode.h / 2} C${reviewNode.x + reviewNode.w + 50},${reviewNode.y + reviewNode.h / 2} ${orchestrator.x + orchestrator.w + 50},${orchestrator.y + orchestrator.h / 2} ${orchestrator.x + orchestrator.w + 10},${orchestrator.y + orchestrator.h / 2}`}
                stroke="#d4d4d4"
                strokeWidth="1.5"
                strokeDasharray="4 4"
                className="flow-line flow-line-delay-2"
                markerEnd="url(#arrowhead)"
              />

              {/* Arrow marker */}
              <defs>
                <marker
                  id="arrowhead"
                  markerWidth="8"
                  markerHeight="6"
                  refX="8"
                  refY="3"
                  orient="auto"
                >
                  <polygon points="0 0, 8 3, 0 6" fill="#a3a3a3" />
                </marker>
              </defs>

              {/* ── Orchestrator node ── */}
              <g>
                <rect
                  x={orchestrator.x}
                  y={orchestrator.y}
                  width={orchestrator.w}
                  height={orchestrator.h}
                  rx="10"
                  fill="#0a0a0a"
                  stroke="#0a0a0a"
                  strokeWidth="2"
                />
                <text
                  x={orchestrator.x + orchestrator.w / 2}
                  y={orchestrator.y + 28}
                  textAnchor="middle"
                  fill="white"
                  fontSize="13"
                  fontWeight="700"
                  fontFamily="Bricolage Grotesque, sans-serif"
                >
                  Polpo
                </text>
                <text
                  x={orchestrator.x + orchestrator.w / 2}
                  y={orchestrator.y + 46}
                  textAnchor="middle"
                  fill="#a3a3a3"
                  fontSize="10"
                  fontFamily="DM Sans, sans-serif"
                >
                  Plan · Delegate · Review
                </text>
              </g>

              {/* ── Agent nodes ── */}
              {agents.map((a, i) => {
                const c = statusColors[a.status];
                return (
                  <g key={i}>
                    <rect
                      x={a.x}
                      y={a.y}
                      width="140"
                      height="58"
                      rx="8"
                      fill={c.bg}
                      stroke={c.border}
                      strokeWidth="1.5"
                    />
                    {/* Status dot */}
                    <circle cx={a.x + 16} cy={a.y + 22} r="4" fill={c.dot}>
                      {a.status === "active" && (
                        <animate
                          attributeName="opacity"
                          values="1;0.4;1"
                          dur="1.5s"
                          repeatCount="indefinite"
                        />
                      )}
                    </circle>
                    <text
                      x={a.x + 28}
                      y={a.y + 26}
                      fill="#171717"
                      fontSize="12"
                      fontWeight="700"
                      fontFamily="DM Mono, monospace"
                    >
                      {a.name}
                    </text>
                    <text
                      x={a.x + 16}
                      y={a.y + 44}
                      fill="#737373"
                      fontSize="10"
                      fontFamily="DM Sans, sans-serif"
                    >
                      {a.role}
                    </text>
                  </g>
                );
              })}

              {/* ── G-Eval review node ── */}
              <g>
                <rect
                  x={reviewNode.x}
                  y={reviewNode.y}
                  width={reviewNode.w}
                  height={reviewNode.h}
                  rx="10"
                  fill="#fafafa"
                  stroke="#e5e5e5"
                  strokeWidth="1.5"
                  strokeDasharray="4 2"
                />
                <text
                  x={reviewNode.x + reviewNode.w / 2}
                  y={reviewNode.y + 26}
                  textAnchor="middle"
                  fill="#171717"
                  fontSize="12"
                  fontWeight="700"
                  fontFamily="DM Mono, monospace"
                >
                  G-Eval Review
                </text>
                <text
                  x={reviewNode.x + reviewNode.w / 2}
                  y={reviewNode.y + 44}
                  textAnchor="middle"
                  fill="#737373"
                  fontSize="10"
                  fontFamily="DM Sans, sans-serif"
                >
                  3 judges · median score
                </text>
              </g>

              {/* ── Edges from agents to review ── */}
              {agents.slice(0, 2).map((a, i) => {
                const startX = a.x + 70;
                const startY = a.y + 58;
                const endX = reviewNode.x;
                const endY = reviewNode.y + reviewNode.h / 2;
                const midY = startY + 30;
                return (
                  <path
                    key={`rev-${i}`}
                    d={`M${startX},${startY} C${startX},${midY} ${endX - 20},${endY} ${endX},${endY}`}
                    stroke="#d4d4d4"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                    opacity="0.5"
                  />
                );
              })}

              {/* ── Legend ── */}
              <g transform="translate(16, 300)">
                <circle cx="6" cy="6" r="4" fill="#10b981" />
                <text x="16" y="10" fill="#737373" fontSize="9" fontFamily="DM Sans, sans-serif">Active</text>
                <circle cx="66" cy="6" r="4" fill="#a3a3a3" />
                <text x="76" y="10" fill="#737373" fontSize="9" fontFamily="DM Sans, sans-serif">Idle</text>
                <circle cx="116" cy="6" r="4" fill="#737373" />
                <text x="126" y="10" fill="#737373" fontSize="9" fontFamily="DM Sans, sans-serif">Done</text>
              </g>
            </svg>

            {/* Mock task feed */}
            <div className="border-t border-neutral-100 bg-neutral-50 p-5 space-y-2">
              <p className="font-mono text-xs uppercase tracking-wider text-neutral-400">
                Live activity
              </p>
              {[
                {
                  agent: "backend-dev",
                  task: "Set up Express routes with JWT auth",
                  status: "in_progress",
                },
                {
                  agent: "frontend-dev",
                  task: "Create React dashboard components",
                  status: "in_progress",
                },
                {
                  agent: "reviewer",
                  task: "Review API schema",
                  status: "done",
                  score: "4.2 / 5",
                },
                {
                  agent: "polpo",
                  task: "Score below 3.0 on auth middleware — retrying",
                  status: "retry",
                },
              ].map((t, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-md bg-white px-3 py-2 text-sm"
                >
                  {t.status === "in_progress" && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-500" />
                  )}
                  {t.status === "done" && (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  )}
                  {t.status === "retry" && (
                    <RefreshCw className="h-3.5 w-3.5 text-amber-500" />
                  )}
                  <span className="font-mono text-xs font-medium text-neutral-600">
                    {t.agent}
                  </span>
                  <span className="text-neutral-500">{t.task}</span>
                  {t.score && (
                    <span className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      {t.score}
                    </span>
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

/* ── Quality Assurance — G-Eval deep dive ─────────────────────────── */

function QualitySection() {
  const dimensions = [
    { label: "Correctness", weight: "35%", desc: "Logic errors, runtime exceptions, functional accuracy." },
    { label: "Completeness", weight: "30%", desc: "All requirements met, nothing missing, nothing left half-done." },
    { label: "Code Quality", weight: "20%", desc: "Clean structure, naming, maintainability." },
    { label: "Edge Cases", weight: "15%", desc: "Error handling, boundary conditions, resilience." },
  ];

  return (
    <section className="relative border-y border-neutral-100 py-24 md:py-32 overflow-hidden">
      {/* Diagonal lines background */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(135deg, #000 0px, #000 1px, transparent 1px, transparent 16px)",
        }}
      />

      <div className="relative mx-auto max-w-4xl px-6">
        <Reveal>
          <div className="flex items-center justify-center gap-2 mb-4">
            <Scale className="h-5 w-5 text-neutral-400" />
            <span className="font-mono text-xs uppercase tracking-wider text-neutral-400">
              G-Eval Review System
            </span>
          </div>
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight text-neutral-950 sm:text-4xl">
            Every task judged.{" "}
            <span className="text-neutral-400">Nothing ships broken.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-neutral-500">
            3 independent LLM judges review every task output in parallel. Scores are
            aggregated via median with outlier filtering. Below threshold? The
            agent gets targeted feedback and retries automatically.
          </p>
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-8 md:grid-cols-2">
          {/* Left: scoring dimensions */}
          <Reveal delay={0.08}>
            <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
              <div className="border-b border-neutral-100 bg-neutral-50 px-5 py-3">
                <span className="font-mono text-xs uppercase tracking-wider text-neutral-400">
                  Scoring dimensions
                </span>
              </div>
              <div className="divide-y divide-neutral-100">
                {dimensions.map((d, i) => (
                  <div key={i} className="flex items-start gap-4 px-5 py-4">
                    <span className="shrink-0 rounded-md bg-neutral-100 px-2 py-0.5 font-mono text-xs font-bold text-neutral-600">
                      {d.weight}
                    </span>
                    <div>
                      <span className="font-display text-sm font-bold text-neutral-900">
                        {d.label}
                      </span>
                      <p className="mt-0.5 text-xs text-neutral-500 leading-relaxed">
                        {d.desc}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>

          {/* Right: how it works */}
          <Reveal delay={0.16}>
            <div className="space-y-4">
              <div className="rounded-xl border border-neutral-200 bg-white p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-950">
                    <Search className="h-4 w-4 text-white" />
                  </div>
                  <span className="font-display text-sm font-bold text-neutral-900">
                    Phase 1 — Exploration
                  </span>
                </div>
                <p className="text-sm text-neutral-500 leading-relaxed">
                  Each judge explores the codebase with tools — reads files, checks
                  output, analyzes the execution timeline. No guessing.
                </p>
              </div>

              <div className="rounded-xl border border-neutral-200 bg-white p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-950">
                    <BarChart3 className="h-4 w-4 text-white" />
                  </div>
                  <span className="font-display text-sm font-bold text-neutral-900">
                    Phase 2 — Scoring
                  </span>
                </div>
                <p className="text-sm text-neutral-500 leading-relaxed">
                  Structured scores per dimension with reasoning and
                  file:line evidence. Median aggregation filters outliers.
                </p>
              </div>

              <div className="rounded-xl border border-neutral-200 bg-white p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-950">
                    <AlertTriangle className="h-4 w-4 text-white" />
                  </div>
                  <span className="font-display text-sm font-bold text-neutral-900">
                    Expectation Judge
                  </span>
                </div>
                <p className="text-sm text-neutral-500 leading-relaxed">
                  A meta-judge evaluates whether the expectations themselves are
                  wrong — before blaming the agent. Prevents false failures.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ── Capabilities ──────────────────────────────────────────────────── */

function Capabilities() {
  const caps = [
    {
      icon: Code2,
      title: "Code",
      desc: "Read, write, edit, run shell commands across your project.",
    },
    {
      icon: Globe,
      title: "Browse the web",
      desc: "Navigate, click, fill forms, screenshot. Persistent logins.",
    },
    {
      icon: Mail,
      title: "Email",
      desc: "Send, read, search inbox. SMTP + IMAP with attachments.",
    },
    {
      icon: FileText,
      title: "Documents",
      desc: "Generate PDFs, Word docs, Excel spreadsheets, CSVs.",
    },
    {
      icon: Image,
      title: "Images & video",
      desc: "Generate images, videos, text-to-speech in 400+ voices.",
    },
    {
      icon: Search,
      title: "Search",
      desc: "Semantic web search. Find competitors, research, discover.",
    },
    {
      icon: Shield,
      title: "Secure vault",
      desc: "Per-agent encrypted credentials. AES-256. Zero leaks.",
    },
    {
      icon: Sparkles,
      title: "Skills",
      desc: "Agents learn and evolve. Install, create, or let Polpo figure it out.",
    },
  ];
  return (
    <section className="bg-neutral-50/50 py-24 md:py-32">
      <div className="mx-auto max-w-4xl px-6">
        <Reveal>
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight text-neutral-950 sm:text-4xl">
            Your agents aren't chatbots.
            <br />
            <span className="text-neutral-400">
              They're workers with real tools.
            </span>
          </h2>
        </Reveal>
        <div className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-neutral-200 bg-neutral-200 sm:grid-cols-2 lg:grid-cols-4">
          {caps.map((c, i) => {
            const Icon = c.icon;
            return (
              <Reveal key={i} delay={i * 0.04} className="bg-white p-6">
                <Icon
                  className="mb-3 h-5 w-5 text-neutral-400"
                  strokeWidth={1.5}
                />
                <h3 className="font-display text-sm font-bold text-neutral-900">
                  {c.title}
                </h3>
                <p className="mt-1 text-sm leading-snug text-neutral-500">
                  {c.desc}
                </p>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ── Feature showcase with links ──────────────────────────────────── */

function FeatureShowcase() {
  const features: {
    icon: LucideIcon;
    title: string;
    desc: string;
    link: string;
    linkLabel: string;
  }[] = [
    {
      icon: Target,
      title: "Missions & Plans",
      desc: "Define complex goals, Polpo breaks them into tasks with dependencies and agent assignments.",
      link: "https://docs.polpo.sh/concepts/missions",
      linkLabel: "Mission guide",
    },
    {
      icon: BarChart3,
      title: "LLM-as-Judge Review",
      desc: "3 parallel judges score every task across 4 dimensions. Below threshold? Automatic retry with targeted fixes.",
      link: "https://docs.polpo.sh/features/review",
      linkLabel: "Review pipeline",
    },
    {
      icon: Users,
      title: "Teams & Roles",
      desc: "Define specialized agents with roles, skills, and tool access. Assign them to teams.",
      link: "https://docs.polpo.sh/concepts/teams",
      linkLabel: "Team setup",
    },
    {
      icon: Bell,
      title: "Notifications",
      desc: "Slack, Telegram, email, webhooks. Get pinged on approvals, completions, and failures.",
      link: "https://docs.polpo.sh/features/notifications",
      linkLabel: "Notification channels",
    },
    {
      icon: ShieldCheck,
      title: "Approval Gates",
      desc: "Human-in-the-loop checkpoints. Block critical tasks until you review and approve.",
      link: "https://docs.polpo.sh/features/approval-gates",
      linkLabel: "Approval setup",
    },
    {
      icon: MessageSquare,
      title: "Chat Interface",
      desc: "Talk to Polpo like a project manager. Describe what you need, it handles the rest.",
      link: "https://docs.polpo.sh/usage/tui",
      linkLabel: "Chat & TUI guide",
    },
    {
      icon: Sparkles,
      title: "Skills System",
      desc: "Agents learn through reusable skills. Install from community, create custom, or let Polpo evolve them.",
      link: "https://docs.polpo.sh/features/skills",
      linkLabel: "Skills guide",
    },
    {
      icon: RefreshCw,
      title: "Scheduling",
      desc: "Run missions on a cron schedule. Automate recurring workflows while you sleep.",
      link: "https://docs.polpo.sh/features/scheduling",
      linkLabel: "Scheduling guide",
    },
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
                  <Icon
                    className="mb-3 h-5 w-5 text-neutral-400"
                    strokeWidth={1.5}
                  />
                  <h3 className="font-display text-sm font-bold text-neutral-900">
                    {f.title}
                  </h3>
                  <p className="mt-1.5 flex-1 text-sm leading-snug text-neutral-500">
                    {f.desc}
                  </p>
                  <a
                    href={f.link}
                    className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-neutral-400 transition group-hover:text-neutral-900"
                  >
                    {f.linkLabel}{" "}
                    <ArrowRight className="h-3 w-3" />
                  </a>
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
  const options: {
    icon: LucideIcon;
    title: string;
    desc: string;
    link: string;
  }[] = [
    {
      icon: Terminal,
      title: "Your laptop",
      desc: "npm install and go. Zero config.",
      link: "https://docs.polpo.sh/install",
    },
    {
      icon: Globe,
      title: "Any VPS",
      desc: "Hetzner, DigitalOcean, AWS, GCP.",
      link: "https://docs.polpo.sh/install/hetzner",
    },
    {
      icon: Bot,
      title: "Docker",
      desc: "One-line container, ready to serve.",
      link: "https://docs.polpo.sh/install#docker",
    },
    {
      icon: Rocket,
      title: "Railway / Fly",
      desc: "Deploy from Git in 60 seconds.",
      link: "https://docs.polpo.sh/install/railway",
    },
  ];
  return (
    <section className="py-24 md:py-32">
      <div className="mx-auto max-w-3xl px-6">
        <Reveal>
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight text-neutral-950 sm:text-4xl">
            Deploy{" "}
            <span className="text-neutral-400">anywhere.</span>
          </h2>
        </Reveal>
        <div className="mt-12 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {options.map((o, i) => {
            const Icon = o.icon;
            return (
              <Reveal key={i} delay={i * 0.05}>
                <a
                  href={o.link}
                  className="group flex flex-col items-center rounded-xl border border-neutral-200 bg-white p-6 text-center transition hover:border-neutral-300 hover:shadow-sm"
                >
                  <Icon
                    className="mb-3 h-6 w-6 text-neutral-400 transition group-hover:text-neutral-900"
                    strokeWidth={1.5}
                  />
                  <span className="font-display text-sm font-bold text-neutral-900">
                    {o.title}
                  </span>
                  <span className="mt-1 text-xs text-neutral-500">
                    {o.desc}
                  </span>
                </a>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    { cmd: "polpo init", note: "Initialize your project" },
    {
      cmd: 'polpo plan create "Build a REST API with auth"',
      note: "Describe what you need",
    },
    { cmd: "polpo run", note: "Walk away" },
  ];
  return (
    <section className="py-24 md:py-32">
      <div className="mx-auto max-w-2xl px-6">
        <Reveal>
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight text-neutral-950 sm:text-4xl">
            Three commands.{" "}
            <span className="text-neutral-400">That's it.</span>
          </h2>
        </Reveal>
        <Reveal delay={0.12}>
          <div className="mt-12 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-950">
            <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
              <Terminal className="h-4 w-4 text-neutral-500" />
              <span className="font-mono text-xs text-neutral-500">
                terminal
              </span>
            </div>
            <div className="space-y-1 p-5 font-mono text-sm">
              {steps.map((s, i) => (
                <div key={i} className="flex items-start gap-3">
                  <span className="select-none text-neutral-600">$</span>
                  <span className="text-neutral-100">{s.cmd}</span>
                  <span className="ml-auto hidden text-neutral-600 sm:inline">
                    # {s.note}
                  </span>
                </div>
              ))}
              <div className="mt-4 flex items-start gap-3 border-t border-neutral-800 pt-4">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                <span className="text-neutral-400">
                  Mission complete. 4 tasks done, 0 failed. Report sent to
                  Telegram.
                </span>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Differentiators() {
  const items = [
    {
      icon: BotMessageSquare,
      label: "Autonomous",
      text: "Builds missions, picks agents, works through queued tasks 24/7. Walk away.",
    },
    {
      icon: CheckCircle2,
      label: "Reliable",
      text: "Every task scored by 3 LLM judges across 4 dimensions. Below threshold? The agent fixes it. You get results, not retries.",
    },
    {
      icon: Zap,
      label: "Crash-proof",
      text: "Detached processes. Kill Polpo, reboot, lose connection — picks up where it left off.",
    },
    {
      icon: Bell,
      label: "Proactive",
      text: "Reaches you on Slack, Telegram, email, webhooks. You decide when and how.",
    },
    {
      icon: RefreshCw,
      label: "Playbooks",
      text: "Define a mission once, run it forever. Schedule it on cron, iterate on it. Your AI company gets better over time.",
    },
    {
      icon: ShieldCheck,
      label: "Side-effect protection",
      text: "Flags irreversible actions (emails, API calls, deployments) for human approval before re-execution.",
    },
  ];
  return (
    <section className="relative border-t border-neutral-100 bg-neutral-50/50 py-24 md:py-32 overflow-hidden">
      <div className="relative mx-auto max-w-2xl px-6">
        <Reveal>
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight text-neutral-950 sm:text-4xl">
            Software that{" "}
            <span className="text-neutral-400">runs itself.</span>
          </h2>
        </Reveal>
        <div className="mt-12 space-y-1">
          {items.map((d, i) => {
            const Icon = d.icon;
            return (
              <Reveal key={i} delay={i * 0.06}>
                <div className="flex items-start gap-4 rounded-lg px-5 py-4 transition hover:bg-white">
                  <Icon
                    className="mt-0.5 h-5 w-5 shrink-0 text-neutral-400"
                    strokeWidth={1.5}
                  />
                  <div>
                    <span className="font-display text-sm font-bold text-neutral-900">
                      {d.label}
                    </span>
                    <span className="ml-2 text-sm text-neutral-500">
                      {d.text}
                    </span>
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

function CTA() {
  return (
    <section className="relative py-24 text-center md:py-32 overflow-hidden">
      {/* Dot grid */}
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
            <a
              href="https://docs.polpo.sh"
              className="inline-flex items-center gap-2 rounded-lg bg-neutral-950 px-6 py-3 text-sm font-semibold text-white transition hover:bg-neutral-800"
            >
              Get started <ArrowRight className="h-4 w-4" />
            </a>
            <a
              href="https://github.com/lumea-labs/polpo"
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-6 py-3 text-sm font-semibold text-neutral-700 transition hover:border-neutral-400"
            >
              <GitHubIcon className="h-4 w-4" />
              GitHub
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-neutral-200 bg-neutral-50 py-10">
      <div className="mx-auto max-w-5xl px-6">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          {/* Brand */}
          <div>
            <span className="font-display text-lg font-extrabold text-neutral-900">
              Polpo
            </span>
            <p className="mt-1 text-sm text-neutral-500">
              Open-source AI agent orchestration.
            </p>
          </div>

          {/* Link columns */}
          <div className="flex gap-16">
            <div>
              <p className="font-mono text-xs uppercase tracking-wider text-neutral-400 mb-3">
                Resources
              </p>
              <nav className="flex flex-col gap-2">
                <a href="https://docs.polpo.sh" className="text-sm text-neutral-600 hover:text-neutral-950 transition">Documentation</a>
                <a href="https://docs.polpo.sh/install" className="text-sm text-neutral-600 hover:text-neutral-950 transition">Install guide</a>
                <a href="https://docs.polpo.sh/concepts/missions" className="text-sm text-neutral-600 hover:text-neutral-950 transition">Missions</a>
                <a href="https://docs.polpo.sh/features/review" className="text-sm text-neutral-600 hover:text-neutral-950 transition">Review pipeline</a>
              </nav>
            </div>
            <div>
              <p className="font-mono text-xs uppercase tracking-wider text-neutral-400 mb-3">
                Community
              </p>
              <nav className="flex flex-col gap-2">
                <a href="https://github.com/lumea-labs/polpo" className="text-sm text-neutral-600 hover:text-neutral-950 transition flex items-center gap-1.5">
                  <GitHubIcon className="h-3.5 w-3.5" /> GitHub
                </a>
                <a href="https://www.npmjs.com/package/@polpo-ai/polpo" className="text-sm text-neutral-600 hover:text-neutral-950 transition">npm</a>
                <a href="https://github.com/lumea-labs/polpo/issues" className="text-sm text-neutral-600 hover:text-neutral-950 transition">Issues</a>
                <a href="https://github.com/lumea-labs/polpo/blob/main/CONTRIBUTING.md" className="text-sm text-neutral-600 hover:text-neutral-950 transition">Contributing</a>
              </nav>
            </div>
          </div>
        </div>

        <div className="mt-8 flex items-center justify-between border-t border-neutral-200 pt-6">
          <span className="text-xs text-neutral-400">
            MIT License
          </span>
          <span className="text-xs text-neutral-400">
            Built by{" "}
            <a href="https://lumea-technologies.com" className="underline underline-offset-2 hover:text-neutral-600">
              Lumea Technologies
            </a>
          </span>
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
