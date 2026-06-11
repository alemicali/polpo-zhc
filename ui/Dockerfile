# ── Stage 1: Build the SPA ────────────────────────────────────────────────────
FROM node:22-bookworm AS builder

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/client-sdk/package.json packages/client-sdk/
COPY packages/react-sdk/package.json packages/react-sdk/
COPY ui/package.json ui/
COPY website/package.json website/
RUN pnpm install --frozen-lockfile --filter ui... --ignore-scripts

COPY packages/client-sdk/ packages/client-sdk/
COPY packages/react-sdk/ packages/react-sdk/
COPY ui/ ui/

ARG VITE_POLPO_API_URL=""
RUN pnpm --filter @polpo-ai/sdk build \
    && pnpm --filter @polpo-ai/react build \
    && VITE_POLPO_API_URL="$VITE_POLPO_API_URL" pnpm --filter ui build

# ── Stage 2: Serve with nginx ────────────────────────────────────────────────
FROM nginx:alpine

RUN rm /etc/nginx/conf.d/default.conf

ENV POLPO_API_UPSTREAM=http://server:3890

COPY ui/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY ui/docker-nginx-resolver.envsh /docker-entrypoint.d/10-polpo-resolver.envsh
RUN chmod +x /docker-entrypoint.d/10-polpo-resolver.envsh
COPY --from=builder /app/ui/dist/ /usr/share/nginx/html/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
