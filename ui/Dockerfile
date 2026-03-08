# ── Stage 1: Build the SPA ────────────────────────────────────────────────────
FROM node:22-bookworm AS builder

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

WORKDIR /app

# Copy everything needed for install (workspace manifests + patches)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/client-sdk/package.json packages/client-sdk/
COPY packages/react-sdk/package.json packages/react-sdk/
COPY ui/package.json ui/
RUN pnpm install --frozen-lockfile

# Copy all source and build the dependency chain
COPY packages/client-sdk/ packages/client-sdk/
COPY packages/react-sdk/ packages/react-sdk/
COPY ui/ ui/

# Build: client-sdk → react-sdk → ui
RUN pnpm --filter @polpo-ai/client build && \
    pnpm --filter @polpo-ai/react build && \
    VITE_POLPO_API_URL="" pnpm --filter ui build

# ── Stage 2: Serve with nginx ────────────────────────────────────────────────
FROM nginx:alpine

# Remove default config
RUN rm /etc/nginx/conf.d/default.conf

# Copy our nginx config
COPY ui/nginx.conf /etc/nginx/conf.d/polpo.conf

# Copy built SPA
COPY --from=builder /app/ui/dist/ /usr/share/nginx/html/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
