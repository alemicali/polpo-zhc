import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Node 25+ has its own globalThis.localStorage (undefined without --localstorage-file), and the
// jsdom environment does not replace a global that already exists: turn Node's Web Storage off in
// the test workers so the tests get jsdom's. Older Node versions do not know the flag.
const execArgv = process.allowedNodeEnvironmentFlags.has("--no-experimental-webstorage")
  ? ["--no-experimental-webstorage"]
  : [];

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    include: ["ui/tests/**/*.test.tsx"],
    poolOptions: { forks: { execArgv }, threads: { execArgv } },
  },
});
