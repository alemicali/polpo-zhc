# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-bookworm AS builder

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

WORKDIR /app

# Dependencies first. Copy every workspace manifest so workspace:* references and
# pnpm's lockfile stay valid even when a package is not part of this image.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/core/package.json packages/core/
COPY packages/drizzle/package.json packages/drizzle/
COPY packages/client-sdk/package.json packages/client-sdk/
COPY packages/react-sdk/package.json packages/react-sdk/
COPY packages/server/package.json packages/server/
COPY packages/tools/package.json packages/tools/
COPY packages/vault-crypto/package.json packages/vault-crypto/
COPY ui/package.json ui/
COPY website/package.json website/
RUN pnpm install --frozen-lockfile

# Build the packages used by the CLI/server plus the extended tools package.
COPY packages/core/ packages/core/
COPY packages/drizzle/ packages/drizzle/
COPY packages/server/ packages/server/
COPY packages/tools/ packages/tools/
COPY packages/vault-crypto/ packages/vault-crypto/
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm --filter @polpo-ai/vault-crypto build \
    && pnpm --filter @polpo-ai/core build \
    && pnpm --filter @polpo-ai/drizzle build \
    && pnpm --filter @polpo-ai/server build \
    && pnpm --filter @polpo-ai/tools build \
    && ./node_modules/.bin/tsc

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      chromium \
      curl \
      ffmpeg \
      file \
      findutils \
      fontconfig \
      fonts-dejavu \
      fonts-liberation \
      fonts-noto-core \
      fonts-noto-color-emoji \
      git \
      grep \
      libreoffice-calc \
      libreoffice-impress \
      libreoffice-writer \
      poppler-utils \
      procps \
      python3 \
      python3-pip \
      ripgrep \
      tar \
      unzip \
      zip \
      gzip \
    && npm install -g agent-browser@0.26.0 code-server \
    && npm cache clean --force \
    && pip3 install --no-cache-dir --break-system-packages edge-tts \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

WORKDIR /app

# Production deps only, including optional deps used by document, browser,
# database, email, and media tools.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/core/package.json packages/core/
COPY packages/drizzle/package.json packages/drizzle/
COPY packages/client-sdk/package.json packages/client-sdk/
COPY packages/react-sdk/package.json packages/react-sdk/
COPY packages/server/package.json packages/server/
COPY packages/tools/package.json packages/tools/
COPY packages/vault-crypto/package.json packages/vault-crypto/
COPY ui/package.json ui/
COPY website/package.json website/
RUN pnpm install --frozen-lockfile --prod

# Compiled output (root + workspace packages required by runtime imports).
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/packages/core/dist/ packages/core/dist/
COPY --from=builder /app/packages/drizzle/dist/ packages/drizzle/dist/
COPY --from=builder /app/packages/server/dist/ packages/server/dist/
COPY --from=builder /app/packages/tools/dist/ packages/tools/dist/
COPY --from=builder /app/packages/vault-crypto/dist/ packages/vault-crypto/dist/
COPY docker/server-entrypoint.sh /usr/local/bin/polpo-server-entrypoint
RUN chmod +x /usr/local/bin/polpo-server-entrypoint

VOLUME /workspace

ENV NODE_ENV=production
ENV PORT=3890
ENV POLPO_WORKDIR=/workspace
ENV POLPO_CHROMIUM_EXECUTABLE=/usr/bin/chromium
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage,--disable-gpu

EXPOSE 3890

ENTRYPOINT ["polpo-server-entrypoint"]
