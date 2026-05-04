# Deployment Guide

Polpo self-hosting is split into two Docker images:

- Server image: `ghcr.io/<owner>/<repo>/server` (also published as `ghcr.io/<owner>/<repo>` for backward compatibility)
- UI image: `ghcr.io/<owner>/<repo>/ui`

For this fork, the default compose file points to:

- `ghcr.io/alemicali/polpo/server:latest`
- `ghcr.io/alemicali/polpo/ui:latest`

The server image is the runtime image. It contains the CLI/server build plus the optional runtime dependencies used by the extended tools: document libraries, SQLite/Postgres clients, email clients, `pdftotext` from poppler, system Chromium for Playwright PDF generation, and `edge-tts`.

The UI image is an nginx-served Vite SPA. It proxies `/api`, `/v1`, and `/ws` to the server service, which is the recommended production setup for PWA features and push notification resubscription.

## Local Docker Compose

Run both server and UI with the published images:

```bash
mkdir -p ./data/workspace
docker compose up
```

Defaults:

- UI: `http://localhost:3080`
- Server API: `http://localhost:3890`
- Workspace volume: `./data/workspace:/workspace`

Useful overrides:

```bash
POLPO_UI_PORT=8080 \
POLPO_SERVER_PORT=3890 \
POLPO_WORKSPACE=/absolute/path/to/workspace \
OPENAI_API_KEY=... \
ANTHROPIC_API_KEY=... \
docker compose up
```

To use images from a different GHCR repository:

```bash
POLPO_SERVER_IMAGE=ghcr.io/<owner>/<repo>/server:latest \
POLPO_UI_IMAGE=ghcr.io/<owner>/<repo>/ui:latest \
docker compose up
```

If you want to run the UI from source or Electron while keeping the backend in Docker, run only the server service and point the UI to it:

```bash
docker compose up server
VITE_POLPO_API_URL=http://localhost:3890 pnpm --filter ui dev
```

For a browser-hosted source UI, set `POLPO_CORS_ORIGINS` on the server if the UI origin is not one of the default localhost origins.

To build the images locally from a fork instead of pulling GHCR images:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

## Server Configuration

Important environment variables:

- `PORT`: platform-provided HTTP port. The Docker entrypoint defaults to `3890`.
- `POLPO_WORKDIR`: workspace path inside the container. Defaults to `/workspace`.
- `POLPO_API_KEY`: optional API key required by the server.
- `POLPO_CORS_ORIGINS`: comma-separated allowed origins when UI and API are not same-origin.
- `POLPO_MODEL`: optional default model override.
- `POLPO_VAULT_KEY`: encryption key for vault data.
- `POLPO_PUSH_VAPID_SUBJECT`: VAPID subject for web push, for example `mailto:admin@example.com` or `https://example.com`.
- Provider keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `AZURE_OPENAI_API_KEY`, `FAL_KEY`, `EXA_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`.
- Email keys: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS`.

The server should normally run as one replica per workspace when using the filesystem/SQLite store, because task state, runs, files, and push subscriptions are workspace-local. Use Postgres only when the configured store supports it for the state you need.

## Koyeb

Recommended Koyeb topology:

1. Create a `server` web service from the server Docker image or the repo root `Dockerfile`.
2. Attach a persistent volume mounted at `/workspace`.
3. Set environment variables:
   - `PORT=3890` or use Koyeb's exposed port value.
   - `POLPO_WORKDIR=/workspace`
   - provider keys and `POLPO_API_KEY` if required.
4. Expose the server privately if it is only consumed by the UI service. Expose it publicly only if external clients must call the API directly.
5. Create a `ui` web service from `ghcr.io/<owner>/<repo>/ui` or `ui/Dockerfile`.
6. Set `POLPO_API_UPSTREAM=http://<server-private-domain>:3890` on the UI service.
7. Expose only the UI service publicly at `/`.
8. Keep the server at one instance when using local filesystem persistence.

Koyeb web services define exposed ports/routes and always provide a `PORT` variable. If `PORT` is not set manually, it is set from the lowest exposed port. Koyeb also supports private service mesh access when a port is not public.

For PWA install and push notifications, prefer a custom HTTPS domain on the UI service. With the UI image, the browser sees same-origin `/api`, `/v1`, and `/ws` routes while nginx forwards them to the private server.

## Railway

Recommended Railway topology:

1. Create a `server` service using the root `Dockerfile` or `ghcr.io/<owner>/<repo>/server`.
2. Add a volume mounted at `/workspace`.
3. Do not hardcode a public port unless needed; the entrypoint reads `PORT`, so Railway can provide it. If you want a fixed internal port, set `PORT=3890`.
4. Set `POLPO_WORKDIR=/workspace` and provider keys.
5. Create a `ui` service from `ui/Dockerfile` or `ghcr.io/<owner>/<repo>/ui`.
6. Set `POLPO_API_UPSTREAM` to the server's private Railway URL, for example `http://server.railway.internal:3890` if the service is named `server` and `PORT=3890`.
7. Expose the UI service publicly. Keep the server private unless external API access is required.

Railway requires services to listen on `0.0.0.0:$PORT` for public networking; the server image does that by default. Railway volumes are mounted at runtime, so persist Polpo workspace data under `/workspace`, not during build.

## Static UI on Vercel or Cloudflare Pages

You can host only the SPA on Vercel or Cloudflare Pages and keep the Polpo server elsewhere, such as Koyeb, Railway, or local Docker.

Build from the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @polpo-ai/sdk build
pnpm --filter @polpo-ai/react build
VITE_POLPO_API_URL=https://api.example.com pnpm --filter ui build
```

Static output directory:

```text
ui/dist
```

On Vercel, use a Vite/static deployment from the repo root and set `VITE_POLPO_API_URL` as a build-time environment variable.

On Cloudflare Pages, set:

- Build command: the command above, or a project script that does the same.
- Build output directory: `ui/dist`
- Node version: Node 22, if your Pages project does not already use it.
- Environment variable: `VITE_POLPO_API_URL=https://api.example.com`

When UI and API are split across different domains, also set server CORS:

```bash
POLPO_CORS_ORIGINS=https://app.example.com
```

The split-domain setup works for normal UI API calls, but the Docker UI proxy is still the best PWA setup because the service worker can keep using same-origin `/api` routes for subscription refreshes.

## Image Build Matrix

Release tags publish:

- `ghcr.io/<owner>/<repo>/server:latest`
- `ghcr.io/<owner>/<repo>/server:<version>`
- `ghcr.io/<owner>/<repo>/ui:latest`
- `ghcr.io/<owner>/<repo>/ui:<version>`
- `ghcr.io/<owner>/<repo>:latest` as a compatibility alias for the server image
- `ghcr.io/<owner>/<repo>:<version>` as a compatibility alias for the server image

For local builds:

```bash
docker build -t polpo-server .
docker build -f ui/Dockerfile -t polpo-ui .
```
