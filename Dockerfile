# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-bookworm AS builder

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

WORKDIR /app

# Dependencies first (cache layer)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Source + compile
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git bash curl ca-certificates poppler-utils \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

WORKDIR /app

# Production deps only
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Compiled output + templates
COPY --from=builder /app/dist/ dist/
COPY templates/ templates/

# Workspace volume — this is where your project lives
VOLUME /workspace

ENV NODE_ENV=production
EXPOSE 3000

# Default: headless server mode
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "3000", "--dir", "/workspace"]
