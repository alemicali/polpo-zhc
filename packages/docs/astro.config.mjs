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
          href: "https://github.com/AlessioToniworking/orchestra",
        },
      ],
      plugins: [
        starlightThemeSix({
          footerText:
            "Built with [Astro Starlight](https://starlight.astro.build). Powered by [Polpo](https://github.com/AlessioToniworking/orchestra).",
        }),
      ],
      sidebar: [
        { label: "Introduction", slug: "introduction" },
        { label: "Getting Started", slug: "getting-started" },
        { label: "Configuration", slug: "configuration" },
        {
          label: "Concepts",
          items: [
            { label: "Architecture", slug: "concepts/architecture" },
            { label: "Task Lifecycle", slug: "concepts/task-lifecycle" },
            { label: "Plans", slug: "concepts/plans" },
            { label: "Assessment", slug: "concepts/assessment" },
          ],
        },
        {
          label: "Usage",
          items: [
            { label: "CLI", slug: "usage/cli" },
            { label: "TUI", slug: "usage/tui" },
            { label: "Server", slug: "usage/server" },
            { label: "Web UI", slug: "usage/web-ui" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Your First Plan", slug: "guides/first-plan" },
            { label: "Custom Adapter", slug: "guides/custom-adapter" },
            { label: "Project Memory", slug: "guides/memory" },
            { label: "Crash Resilience", slug: "guides/resilience" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Configuration", slug: "reference/config" },
            { label: "REST API", slug: "reference/api" },
            { label: "Events", slug: "reference/events" },
            { label: "React SDK", slug: "reference/react-sdk" },
            { label: "Adapters", slug: "reference/adapters" },
          ],
        },
        {
          label: "Advanced",
          items: [
            {
              label: "Deadlock Resolution",
              slug: "advanced/deadlock-resolution",
            },
            {
              label: "Retry & Escalation",
              slug: "advanced/retry-escalation",
            },
            {
              label: "Question Detection",
              slug: "advanced/question-detection",
            },
            {
              label: "Expectation Judge",
              slug: "advanced/expectation-judge",
            },
          ],
        },
      ],
    }),
  ],
});
