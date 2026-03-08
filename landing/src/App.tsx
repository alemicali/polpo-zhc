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
} from "lucide-react";

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

/* ── Sections ──────────────────────────────────────────────────────── */

function Hero() {
  return (
    <section className="relative overflow-hidden pt-32 pb-24 md:pt-44 md:pb-32">
      {/* Subtle radial glow */}
      <div className="pointer-events-none absolute -top-48 left-1/2 -translate-x-1/2 h-[600px] w-[800px] bg-[radial-gradient(ellipse,rgba(0,0,0,0.04)_0%,transparent_70%)]" />

      <div className="mx-auto max-w-3xl px-6 text-center">
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
            Assemble AI agent teams that plan, execute, review their own work,
            and ping you only when it matters. On your laptop, your VPS, your
            rules.
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
    <section className="border-y border-neutral-100 bg-neutral-50/50 py-24 md:py-32">
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
                <Icon className="mb-3 h-5 w-5 text-neutral-400" strokeWidth={1.5} />
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
      text: "Builds missions, picks agents, works through tasks 24/7. Walk away.",
    },
    {
      icon: CheckCircle2,
      label: "Reliable",
      text: "Every task scored by LLM judges. Below threshold? The agent fixes it.",
    },
    {
      icon: Zap,
      label: "Crash-proof",
      text: "Detached processes. Kill, reboot, lose connection — picks up where it left off.",
    },
    {
      icon: Bell,
      label: "Proactive",
      text: "Reaches you on Slack, Telegram, email, webhooks. You decide when.",
    },
    {
      icon: RefreshCw,
      label: "Playbooks",
      text: "Define a mission once, run it forever. Your AI company gets better over time.",
    },
  ];
  return (
    <section className="border-t border-neutral-100 bg-neutral-50/50 py-24 md:py-32">
      <div className="mx-auto max-w-2xl px-6">
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

function Stats() {
  const stats = [
    { num: "5,000+", label: "community skills" },
    { num: "22+", label: "LLM providers" },
    { num: "70+", label: "built-in tools" },
  ];
  return (
    <section className="py-24 md:py-32">
      <div className="mx-auto max-w-3xl px-6">
        <Reveal>
          <div className="grid grid-cols-3 divide-x divide-neutral-200 rounded-xl border border-neutral-200">
            {stats.map((s, i) => (
              <div key={i} className="px-6 py-10 text-center">
                <span className="font-display text-3xl font-extrabold text-neutral-950 sm:text-4xl">
                  {s.num}
                </span>
                <span className="mt-1 block font-mono text-xs uppercase tracking-wider text-neutral-400">
                  {s.label}
                </span>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className="border-t border-neutral-100 bg-neutral-50/50 py-24 text-center md:py-32">
      <div className="mx-auto max-w-2xl px-6">
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
    <footer className="border-t border-neutral-200 py-8">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-4 px-6">
        <span className="font-display text-sm font-bold text-neutral-900">
          Polpo
        </span>
        <nav className="flex gap-6">
          {[
            ["Docs", "https://docs.polpo.sh"],
            ["GitHub", "https://github.com/lumea-labs/polpo"],
            ["npm", "https://www.npmjs.com/package/@polpo-ai/polpo"],
          ].map(([label, href]) => (
            <a
              key={label}
              href={href}
              className="text-sm text-neutral-500 transition hover:text-neutral-900"
            >
              {label}
            </a>
          ))}
        </nav>
        <span className="text-xs text-neutral-400">
          Built by{" "}
          <a href="https://lumea.tech" className="underline underline-offset-2 hover:text-neutral-600">
            Lumea Labs
          </a>
        </span>
      </div>
    </footer>
  );
}

/* ── App ───────────────────────────────────────────────────────────── */

export function App() {
  return (
    <div className="min-h-screen bg-white text-neutral-950">
      <div className="grain" />
      <Hero />
      <Comparison />
      <Capabilities />
      <HowItWorks />
      <Differentiators />
      <Stats />
      <CTA />
      <Footer />
    </div>
  );
}
