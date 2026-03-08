export type PackageType = "playbook" | "agent" | "company";

export interface InkPackage {
  name: string;
  type: PackageType;
  description: string;
  source: string; // owner/repo
  tags: string[];
  version?: string;
  author?: string;
  /** Longer description shown on detail page */
  details?: string;
  /** File convention path */
  conventionPath?: string;
  /** What's included — list of features/files */
  includes?: string[];
  /** Total install count */
  installs: number;
  /** Installs in the last 24 hours */
  installs24h: number;
  /** Date the package was first published */
  publishedAt: string; // ISO date
}

/** All unique tags across packages */
export function getAllTags(packages: InkPackage[]): string[] {
  const set = new Set<string>();
  for (const p of packages) for (const t of p.tags) set.add(t);
  return Array.from(set).sort();
}

export const PACKAGES: InkPackage[] = [
  // ── Playbooks ──────────────────────────────────────────────────────

  {
    name: "rest-api-scaffold",
    type: "playbook",
    description: "Scaffold a REST API with Express, JWT auth, Prisma ORM, and full test coverage.",
    source: "lumea-labs/ink-registry",
    tags: ["backend", "api", "express", "prisma"],
    version: "1.0.0",
    author: "lumea-labs",
    installs: 4820,
    installs24h: 127,
    publishedAt: "2025-11-15",
    conventionPath: "playbooks/rest-api-scaffold/playbook.json",
    details:
      "A production-ready playbook that scaffolds a Node.js REST API from scratch. Includes Express server setup, JWT authentication middleware, Prisma ORM with PostgreSQL, input validation with Zod, error handling, rate limiting, and a full test suite with Vitest. The playbook assigns tasks to a backend developer agent and a technical writer agent for API documentation.",
    includes: [
      "Express server with TypeScript",
      "JWT auth (register, login, refresh, logout)",
      "Prisma ORM with migrations",
      "Zod input validation",
      "Error handling middleware",
      "Rate limiting",
      "Vitest test suite",
      "API documentation (OpenAPI)",
    ],
  },
  {
    name: "fullstack-app",
    type: "playbook",
    description: "Full-stack app with Next.js frontend, tRPC API layer, and PostgreSQL database.",
    source: "lumea-labs/ink-registry",
    tags: ["fullstack", "nextjs", "trpc", "postgres"],
    version: "1.0.0",
    author: "lumea-labs",
    installs: 3640,
    installs24h: 98,
    publishedAt: "2025-12-01",
    conventionPath: "playbooks/fullstack-app/playbook.json",
    details:
      "End-to-end fullstack application playbook using the T3 stack pattern. Sets up a Next.js app with App Router, tRPC for type-safe API calls, Drizzle ORM for database access, and Tailwind CSS for styling. Assigns frontend tasks, backend tasks, and database setup across multiple agents in parallel.",
    includes: [
      "Next.js 14 with App Router",
      "tRPC v11 API layer",
      "Drizzle ORM + PostgreSQL",
      "Tailwind CSS + shadcn/ui",
      "Authentication (NextAuth.js)",
      "Form validation (Zod)",
      "E2E tests (Playwright)",
    ],
  },
  {
    name: "landing-page",
    type: "playbook",
    description: "Build a conversion-optimized landing page with React, Tailwind, and motion animations.",
    source: "lumea-labs/ink-registry",
    tags: ["frontend", "landing", "react", "tailwind"],
    version: "1.0.0",
    author: "lumea-labs",
    installs: 2910,
    installs24h: 156,
    publishedAt: "2026-01-10",
    conventionPath: "playbooks/landing-page/playbook.json",
    details:
      "A playbook for building high-converting landing pages. Creates a Vite + React project with Tailwind CSS, Motion animations, responsive design, SEO meta tags, and performance optimization. Includes hero section, features grid, social proof, pricing, and CTA sections.",
    includes: [
      "Vite + React + TypeScript",
      "Tailwind CSS v4",
      "Motion (Framer Motion) animations",
      "SEO meta tags + Open Graph",
      "Responsive design (mobile-first)",
      "Performance optimization (Lighthouse 95+)",
      "Analytics integration",
    ],
  },
  {
    name: "cli-tool",
    type: "playbook",
    description: "Build a Node.js CLI tool with Commander, interactive prompts, and configuration management.",
    source: "lumea-labs/ink-registry",
    tags: ["cli", "nodejs", "commander"],
    version: "1.0.0",
    author: "lumea-labs",
    installs: 1580,
    installs24h: 42,
    publishedAt: "2026-01-20",
    conventionPath: "playbooks/cli-tool/playbook.json",
    details:
      "Scaffold a production-ready CLI tool with Commander.js for argument parsing, Inquirer for interactive prompts, Chalk for colored output, and Cosmiconfig for configuration file support. Includes shell completion generation and man page output.",
    includes: [
      "Commander.js argument parsing",
      "Interactive prompts (Inquirer)",
      "Colored output (Chalk)",
      "Config file support (Cosmiconfig)",
      "Shell completion generation",
      "npm publish setup",
      "Unit tests",
    ],
  },
  {
    name: "chrome-extension",
    type: "playbook",
    description: "Chrome extension with Manifest V3, popup UI, content scripts, and background service worker.",
    source: "lumea-labs/ink-registry",
    tags: ["browser", "chrome", "extension"],
    version: "1.0.0",
    author: "lumea-labs",
    installs: 1120,
    installs24h: 67,
    publishedAt: "2026-02-05",
    conventionPath: "playbooks/chrome-extension/playbook.json",
    details:
      "Build a Chrome extension from scratch using Manifest V3. Includes popup UI with React, content scripts for page manipulation, background service worker for event handling, Chrome storage API integration, and message passing between contexts.",
    includes: [
      "Manifest V3 setup",
      "Popup UI (React + Tailwind)",
      "Content scripts",
      "Background service worker",
      "Chrome storage API",
      "Message passing (port + runtime)",
      "Build pipeline (Vite)",
    ],
  },
  {
    name: "documentation-site",
    type: "playbook",
    description: "Generate a documentation site from your codebase with Mintlify, auto-generated API references.",
    source: "lumea-labs/ink-registry",
    tags: ["docs", "mintlify", "documentation"],
    version: "1.0.0",
    author: "lumea-labs",
    installs: 890,
    installs24h: 31,
    publishedAt: "2026-02-18",
    conventionPath: "playbooks/documentation-site/playbook.json",
    details:
      "Automatically generate a documentation site by analyzing your codebase. Uses Mintlify for the docs framework, auto-generates API reference from OpenAPI specs or JSDoc comments, creates getting started guides, and produces architecture diagrams.",
    includes: [
      "Mintlify docs framework",
      "Auto-generated API reference",
      "Getting started guide",
      "Architecture diagrams",
      "Code examples extraction",
      "Search integration",
      "GitHub Actions for auto-deploy",
    ],
  },

  // ── Agents ─────────────────────────────────────────────────────────

  {
    name: "senior-backend-dev",
    type: "agent",
    description: "Senior backend developer — Node.js, Python, databases, APIs. Writes tests, handles edge cases.",
    source: "lumea-labs/ink-registry",
    tags: ["backend", "nodejs", "python", "senior"],
    version: "1.0.0",
    author: "lumea-labs",
    installs: 5230,
    installs24h: 189,
    publishedAt: "2025-11-01",
    conventionPath: "agents/senior-backend-dev.json",
    details:
      "A senior backend developer agent with expertise in Node.js and Python. Writes production-quality code with proper error handling, input validation, database queries, and comprehensive test coverage. Understands architectural patterns (MVC, Clean Architecture, hexagonal) and makes pragmatic decisions.",
    includes: [
      "Node.js / TypeScript expertise",
      "Python backend (FastAPI, Django)",
      "Database design (PostgreSQL, MongoDB)",
      "REST + GraphQL API design",
      "Authentication & authorization",
      "Testing (unit, integration)",
      "Performance optimization",
      "Security best practices",
    ],
  },
  {
    name: "react-specialist",
    type: "agent",
    description: "React/Next.js specialist — components, hooks, state management, performance optimization.",
    source: "lumea-labs/ink-registry",
    tags: ["frontend", "react", "nextjs"],
    version: "1.0.0",
    author: "lumea-labs",
    installs: 4150,
    installs24h: 134,
    publishedAt: "2025-11-08",
    conventionPath: "agents/react-specialist.json",
    details:
      "A frontend specialist agent focused on React and Next.js. Builds accessible, performant UI components with proper state management, custom hooks, and SSR/SSG patterns. Follows composition patterns, avoids prop drilling, and optimizes bundle size.",
    includes: [
      "React 19 / Next.js 14",
      "Component composition patterns",
      "Custom hooks",
      "State management (Zustand, Context)",
      "SSR / SSG / ISR",
      "Accessibility (WCAG 2.1)",
      "Performance (memo, lazy, Suspense)",
      "Testing (React Testing Library)",
    ],
  },
  {
    name: "devops-engineer",
    type: "agent",
    description: "DevOps engineer — Docker, CI/CD, cloud deployment, infrastructure as code.",
    source: "lumea-labs/ink-registry",
    tags: ["devops", "docker", "ci-cd", "cloud"],
    version: "1.0.0",
    author: "lumea-labs",
    installs: 2670,
    installs24h: 73,
    publishedAt: "2025-12-10",
    conventionPath: "agents/devops-engineer.json",
    details:
      "A DevOps engineer agent that handles containerization, CI/CD pipelines, cloud deployment, and infrastructure management. Writes Dockerfiles, GitHub Actions workflows, Terraform configs, and monitoring setups.",
    includes: [
      "Docker + Docker Compose",
      "GitHub Actions CI/CD",
      "Cloud deployment (AWS, GCP, Vercel)",
      "Terraform / Pulumi IaC",
      "Nginx / Caddy reverse proxy",
      "SSL/TLS setup",
      "Monitoring (Prometheus, Grafana)",
      "Log aggregation",
    ],
  },
  {
    name: "technical-writer",
    type: "agent",
    description: "Technical writer — API docs, READMEs, guides, changelogs. Clear, concise, developer-friendly.",
    source: "lumea-labs/ink-registry",
    tags: ["docs", "writing", "api"],
    version: "1.0.0",
    author: "lumea-labs",
    installs: 1940,
    installs24h: 55,
    publishedAt: "2025-12-20",
    conventionPath: "agents/technical-writer.json",
    details:
      "A technical writer agent that produces clear, concise developer documentation. Reads source code, understands APIs, and generates READMEs, API references, migration guides, changelogs, and architecture decision records.",
    includes: [
      "README generation",
      "API reference docs",
      "Getting started guides",
      "Migration guides",
      "Changelog (Keep a Changelog)",
      "Architecture Decision Records",
      "Code examples & snippets",
      "Diagram generation (Mermaid)",
    ],
  },
  {
    name: "security-auditor",
    type: "agent",
    description: "Security auditor — dependency scanning, OWASP checks, secrets detection, vulnerability reports.",
    source: "lumea-labs/ink-registry",
    tags: ["security", "audit", "owasp"],
    version: "1.0.0",
    author: "lumea-labs",
    installs: 1350,
    installs24h: 88,
    publishedAt: "2026-01-15",
    conventionPath: "agents/security-auditor.json",
    details:
      "A security-focused agent that audits codebases for vulnerabilities. Scans dependencies for known CVEs, checks for OWASP Top 10 issues, detects hardcoded secrets, reviews authentication flows, and produces detailed security reports with remediation steps.",
    includes: [
      "Dependency vulnerability scanning",
      "OWASP Top 10 checklist",
      "Secrets detection (API keys, tokens)",
      "Auth flow review",
      "SQL injection / XSS detection",
      "Security headers check",
      "Remediation recommendations",
      "Compliance report generation",
    ],
  },
  {
    name: "data-analyst",
    type: "agent",
    description: "Data analyst — SQL queries, data pipelines, visualization, statistical analysis, reporting.",
    source: "lumea-labs/ink-registry",
    tags: ["data", "sql", "analytics"],
    version: "1.0.0",
    author: "lumea-labs",
    installs: 980,
    installs24h: 45,
    publishedAt: "2026-02-01",
    conventionPath: "agents/data-analyst.json",
    details:
      "A data analyst agent that writes SQL queries, builds data pipelines, creates visualizations, and performs statistical analysis. Can work with PostgreSQL, BigQuery, and common BI tools to produce actionable insights and reports.",
    includes: [
      "SQL query writing (PostgreSQL, BigQuery)",
      "Data pipeline design (ETL)",
      "Statistical analysis",
      "Data visualization",
      "Report generation",
      "A/B test analysis",
      "Dashboard design",
      "Data quality checks",
    ],
  },

  // ── Companies ──────────────────────────────────────────────────────

  {
    name: "saas-starter",
    type: "company",
    description: "Complete SaaS company setup — backend dev, frontend dev, devops, technical writer. Ready to build.",
    source: "lumea-labs/ink-registry",
    tags: ["saas", "starter", "fullstack"],
    version: "1.0.0",
    author: "lumea-labs",
    installs: 2340,
    installs24h: 112,
    publishedAt: "2025-11-20",
    conventionPath: "companies/saas-starter/polpo.json",
    details:
      "A complete AI company configuration for building SaaS products. Includes a backend developer, frontend developer, devops engineer, and technical writer — each with roles, skills, and tool access pre-configured. Teams are structured with proper task dependencies and review criteria.",
    includes: [
      "4 pre-configured agents",
      "Team structure with roles",
      "Task dependency templates",
      "G-Eval review criteria",
      "Credential vault setup",
      "Notification channels",
      "Playbook references",
    ],
  },
  {
    name: "content-agency",
    type: "company",
    description: "Content agency — researcher, writer, editor, SEO specialist. End-to-end content production.",
    source: "lumea-labs/ink-registry",
    tags: ["content", "agency", "writing", "seo"],
    version: "1.0.0",
    author: "lumea-labs",
    installs: 1560,
    installs24h: 63,
    publishedAt: "2026-01-05",
    conventionPath: "companies/content-agency/polpo.json",
    details:
      "A content production company with agents specialized in research, writing, editing, and SEO optimization. Produces blog posts, landing page copy, email sequences, and social media content with built-in review and quality scoring.",
    includes: [
      "Researcher agent (web search, analysis)",
      "Writer agent (blog, copy, email)",
      "Editor agent (proofreading, style)",
      "SEO specialist agent",
      "Content calendar workflow",
      "Quality scoring criteria",
      "Publishing pipeline",
    ],
  },
  {
    name: "data-team",
    type: "company",
    description: "Data team — analyst, engineer, ML specialist. Pipeline building, analysis, and reporting.",
    source: "lumea-labs/ink-registry",
    tags: ["data", "ml", "analytics", "team"],
    version: "1.0.0",
    author: "lumea-labs",
    installs: 720,
    installs24h: 28,
    publishedAt: "2026-02-20",
    conventionPath: "companies/data-team/polpo.json",
    details:
      "A data engineering and analytics team. Includes a data analyst, data engineer, and ML specialist with tools for SQL querying, pipeline orchestration, model training, and dashboard building. Designed for recurring data missions on cron schedules.",
    includes: [
      "Data analyst agent",
      "Data engineer agent",
      "ML specialist agent",
      "Pipeline orchestration",
      "Dashboard templates",
      "Cron scheduling setup",
      "Data quality monitoring",
    ],
  },
];

/** Find a package by source and name */
export function findPackage(source: string, name: string): InkPackage | undefined {
  return PACKAGES.find((p) => p.source === source && p.name === name);
}

/** Get all packages from a given source */
export function getPackagesBySource(source: string): InkPackage[] {
  return PACKAGES.filter((p) => p.source === source);
}

/** Format install count (e.g. 4820 -> "4.8K") */
export function formatInstalls(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
