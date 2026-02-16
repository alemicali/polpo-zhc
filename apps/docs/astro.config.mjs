// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightThemeSix from "@six-tech/starlight-theme-six";

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: "Polpo",
      logo: {
        light: "./src/assets/logo.svg",
        dark: "./src/assets/logo-dark.svg",
        replacesTitle: true,
      },
      components: {
        PageFrame: "./src/components/PageFrame.astro",
        Sidebar: "./src/components/Sidebar.astro",
      },
      head: [
        {
          tag: "style",
          content: `
            @import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap');
            .logo-size { height: 1.2rem !important; max-height: 1.2rem !important; width: auto !important; }
            :root { --sl-font: 'Geist', system-ui, sans-serif; --sl-font-mono: 'Geist Mono', monospace; }
            body { font-family: 'Geist', system-ui, sans-serif !important; }
            code, pre, kbd { font-family: 'Geist Mono', monospace !important; }
          `,
        },
      ],
      lastUpdated: true,
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/openpolpo/openpolpo",
        },
      ],
      sidebar: [
        // ── Getting Started ──────────────────────────────────
        { label: "Introduction", slug: "introduction" },
        { label: "Installation & Setup", slug: "getting-started" },
        { label: "Your First Plan", slug: "guides/first-plan" },
        { label: "Configuration", slug: "configuration" },

        // ── Concepts ─────────────────────────────────────────
        {
          label: "Concepts",
          items: [
            { label: "Architecture", slug: "concepts/architecture" },
            { label: "Agents & Teams", slug: "concepts/agents-and-teams" },
            { label: "Task Lifecycle", slug: "concepts/task-lifecycle" },
            { label: "Plans & Dependencies", slug: "concepts/plans" },
            { label: "Result Evaluation", slug: "concepts/assessment" },
            { label: "Tools & MCP", slug: "concepts/tools-and-skills" },
            { label: "Skills", slug: "concepts/skills" },
            { label: "Workflows", slug: "concepts/workflows" },
            { label: "Hooks", slug: "concepts/lifecycle-hooks" },
            { label: "Providers & Models", slug: "concepts/providers-and-models" },
            { label: "Sessions", slug: "concepts/sessions" },
            { label: "Logs & Activity", slug: "concepts/logs-and-activity" },
            { label: "Memory", slug: "concepts/memory" },
          ],
        },

        // ── Orchestration ────────────────────────────────────
        {
          label: "Orchestration",
          items: [
            { label: "Notification System", slug: "orchestration/notifications" },
            { label: "Approval Gates", slug: "orchestration/approval-gates" },
            { label: "Escalation Chain", slug: "orchestration/escalation" },
            { label: "Quality & SLA", slug: "orchestration/quality-sla" },
            { label: "Scheduling", slug: "orchestration/scheduling" },
            { label: "Bridge System", slug: "orchestration/bridge" },
          ],
        },

        // ── Usage ────────────────────────────────────────────
        {
          label: "Usage",
          items: [
            { label: "CLI", slug: "usage/cli" },
            { label: "TUI", slug: "usage/tui" },
            { label: "HTTP Server", slug: "usage/server" },
            { label: "Web UI", slug: "usage/web-ui" },
          ],
        },

        // ── Guides ───────────────────────────────────────────
        {
          label: "Guides",
          items: [
            { label: "Custom Adapter", slug: "guides/custom-adapter" },
            { label: "Crash Resilience", slug: "guides/resilience" },
            { label: "Deadlock Resolution", slug: "guides/deadlock-resolution" },
            { label: "Question Detection", slug: "guides/question-detection" },
            { label: "Expectation Judge", slug: "guides/expectation-judge" },
            { label: "Store Backends", slug: "guides/store-backends" },
            { label: "Writing Workflows", slug: "guides/writing-workflows" },
            { label: "Security", slug: "guides/security" },
          ],
        },

        // ── Reference ────────────────────────────────────────
        {
          label: "Reference",
          items: [
            { label: "Configuration Schema", slug: "reference/config" },
            { label: "REST API", slug: "reference/api" },
            { label: "Events", slug: "reference/events" },
            { label: "React SDK", slug: "reference/react-sdk" },
            { label: "Adapters", slug: "reference/adapters" },
            { label: "Tools Reference", slug: "reference/coding-tools" },
          ],
        },
      ],
      plugins: [
        starlightThemeSix({
          navLinks: [
            { label: "Docs", link: "/introduction" },
            { label: "API", link: "/reference/api" },
            { label: "GitHub", link: "https://github.com/openpolpo/openpolpo", attrs: { target: "_blank" } },
          ],
          footerText:
            "Built with tentacles and [Starlight](https://starlight.astro.build). [Open source](https://github.com/openpolpo/openpolpo), obviously.",
        }),
      ],
    }),
  ],
});
