# Insurtech Solutions — fourth local instance

Created on 2026-09-15 without restarting Lumea, Shoplix or Choosy.

## Endpoints and services

- Web: https://lumea-dev.tailaf83e5.ts.net:5177
- API: https://lumea-dev.tailaf83e5.ts.net:3003
- Data root: `/data/insurtech-solutions`
- Config: `/data/insurtech-solutions/.polpo/polpo.json`
- SQLite database: `/data/insurtech-solutions/.polpo/state.db`
- User services: `polpo-insurtech-server.service`, `polpo-insurtech-ui.service`
- Unit files: `/home/alessio/.config/systemd/user/`
- Backend binds to `127.0.0.1:3003`; UI binds to `127.0.0.1:5177`.
- Existing Tailscale Serve HTTPS proxies for these ports were reused unchanged.
- Coding server range: `3061-3070`, separate from the other instances.

Both services are enabled for automatic startup; user lingering is enabled.
The source/build is shared at `/home/alessio/dev/oss/polpo-zhc`.
No mobile build, EAS update or repository push was required/performed.

## Initial state

Project and sidebar branding: **Insurtech Solutions**; tagline: **AI Workspace**.
Model: `openai-codex:gpt-5.6-terra`, reasoning `medium`, matching Choosy's
current default. No existing company configuration or data was copied.

Initialized the configured SQLite TeamStore using the existing
`dist/cli/stores.js` factory and `teamStore.seed([{name:"default",agents:[]}])`
before first server startup. This retains an empty default team and prevents
the first-run server bootstrap from creating its generic `dev-1` agent.
Initial counts: zero agents, chat sessions, tasks and missions.

## Access and isolation

This is application-data separation, **not OS-level tenant isolation**:
all instances run as the same Unix user and share code and global provider
OAuth credentials. Usage limits/cooldowns for shared accounts also remain
shared. No credentials were copied into the new project config.

The data root and `.polpo` directory are mode 0700; the config is mode 0600.
Both services use `UMask=0077`. These permissions do not isolate processes
running as the same Unix user.

Access is through Tailscale; no Funnel was enabled. No separate application
login/API key was configured. Tailnet access policies are the network access
boundary. Configure dedicated authentication/OS isolation before broadening
access to external company users.

## Verification

- systemd unit verification passed; both new services active and enabled.
- Remote HTTPS API health and UI health returned 200 for all four instances.
- New instance config confirms project, branding, SQLite and model.
- New instance reports initialized with provider credentials detected.
- Agents, sessions and workload counts confirmed empty.
- Runtime UI config points to API port 3003; CORS permits UI origin 5177.
- Browser check displayed the Insurtech Solutions sidebar and empty chat UI.
  The browser tab title remains the shared build's `Polpo ZHC — AI Factory`.
- Other three backend PIDs/start timestamps unchanged.

No paid model completion or end-to-end audio/attachment test was performed
for this new instance. Its application code is the existing shared build.
