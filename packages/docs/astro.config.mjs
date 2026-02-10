// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: "Orchestra",
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
        replacesTitle: true,
      },
      lastUpdated: true,
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/AlessioToniworking/orchestra",
        },
      ],
      expressiveCode: {
        themes: ["github-light", "github-dark"],
      },
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        { label: "Introduction", slug: "index" },
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
