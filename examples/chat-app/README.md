# Polpo Chat Example

A minimal chat app powered by Polpo. React + Vite, zero UI dependencies.

## Quick start

```bash
# Clone and install
cd examples/chat-app
npm install

# Configure
cp .env.example .env
# Edit .env — set your Polpo URL and API key

# Run
npm run dev
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_POLPO_URL` | Polpo API URL | `http://localhost:1355` |
| `VITE_POLPO_API_KEY` | API key (required for cloud) | — |
| `VITE_POLPO_AGENT` | Target agent name (optional) | — |

### Local

```bash
# Terminal 1: start Polpo
polpo start

# Terminal 2: start the chat
cd examples/chat-app
npm run dev
```

### Cloud

```bash
VITE_POLPO_URL=https://api.polpo.sh
VITE_POLPO_API_KEY=sk_live_...
VITE_POLPO_AGENT=my-agent
```

## What's in the box

- `src/App.tsx` — chat UI with streaming, markdown rendering, auto-scroll
- Uses `@polpo-ai/sdk` — `PolpoClient.chatCompletionsStream()` for SSE streaming
- OpenAI-compatible format — same `/v1/chat/completions` endpoint
- No frameworks, no component libraries — just React
