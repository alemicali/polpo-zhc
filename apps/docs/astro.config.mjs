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

        // ── Core Concepts ────────────────────────────────────
        {
          label: "Core Concepts",
          items: [
            { label: "Architecture", slug: "concepts/architecture" },
            { label: "Agents & Teams", slug: "concepts/agents-and-teams" },
            { label: "Task Lifecycle", slug: "concepts/task-lifecycle" },
            { label: "Plans & Dependencies", slug: "concepts/plans" },
            { label: "Providers & Models", slug: "concepts/providers-and-models" },
          ],
        },

        // ── Features ─────────────────────────────────────────
        {
          label: "Features",
          items: [
            { label: "Tools & MCP", slug: "features/tools-and-mcp" },
            { label: "Skills", slug: "features/skills" },
            { label: "Workflows", slug: "features/workflows" },
            { label: "Assessment & Quality", slug: "features/assessment" },
            { label: "Hooks", slug: "features/hooks" },
            { label: "Notifications", slug: "features/notifications" },
            { label: "Approval Gates", slug: "features/approval-gates" },
            { label: "Escalation", slug: "features/escalation" },
            { label: "Scheduling", slug: "features/scheduling" },
            { label: "Sessions & Observability", slug: "features/sessions" },
            { label: "Memory", slug: "features/memory" },
            { label: "Deadlock Resolution", slug: "features/deadlock-resolution" },
            { label: "Question Detection", slug: "features/question-detection" },
            { label: "Crash Resilience", slug: "features/resilience" },
            { label: "Security", slug: "features/security" },
            { label: "Writing Workflows", slug: "features/writing-workflows" },
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

        // ── Reference ────────────────────────────────────────
        {
          label: "Reference",
          items: [
            { label: "Configuration Schema", slug: "reference/config" },
            { label: "REST API", slug: "reference/api" },
            { label: "Events", slug: "reference/events" },
            { label: "React SDK", slug: "reference/react-sdk" },
            { label: "Store Backends", slug: "reference/store-backends" },
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
