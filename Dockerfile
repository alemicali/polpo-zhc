# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-bookworm AS builder

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

WORKDIR /app

# Dependencies first (cache layer)
# Include workspace manifests + patches so pnpm resolves workspace: refs
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/core/package.json packages/core/
COPY packages/drizzle/package.json packages/drizzle/
COPY packages/client-sdk/package.json packages/client-sdk/
COPY packages/react-sdk/package.json packages/react-sdk/
COPY ui/package.json ui/
RUN pnpm install --frozen-lockfile

# Build workspace packages that root src/ re-exports from
COPY packages/core/ packages/core/
COPY packages/drizzle/ packages/drizzle/
RUN pnpm --filter @polpo-ai/core build && pnpm --filter @polpo-ai/drizzle build

# Source + compile root
COPY tsconfig.json ./
COPY src/ src/
RUN ./node_modules/.bin/tsc

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git bash curl ca-certificates poppler-utils \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

WORKDIR /app

# Production deps only
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/core/package.json packages/core/
COPY packages/drizzle/package.json packages/drizzle/
COPY packages/client-sdk/package.json packages/client-sdk/
COPY packages/react-sdk/package.json packages/react-sdk/
COPY ui/package.json ui/
RUN pnpm install --frozen-lockfile --prod

# Compiled output (root + workspace packages)
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/packages/core/dist/ packages/core/dist/
COPY --from=builder /app/packages/drizzle/dist/ packages/drizzle/dist/

# Workspace volume — this is where your project lives
VOLUME /workspace

ENV NODE_ENV=production
EXPOSE 3890

# Default: headless server mode
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "3890", "--dir", "/workspace"]
