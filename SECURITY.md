# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in OpenPolpo, please report it responsibly. **Do not open a public GitHub issue for security vulnerabilities.**

### How to Report

Use the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/lumea-labs/polpo/security/advisories/new) tab to submit a private report.

Alternatively, email **security@polpo.sh** with:

1. A description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested fix (if you have one)

### What to Expect

- **Acknowledgment** within 3 business days
- **Assessment** within 7 business days
- **Fix or mitigation plan** within 30 days for confirmed vulnerabilities
- Credit in the release notes (unless you prefer anonymity)

## Scope

The following are in scope for security reports:

- **Command injection** — agent tools executing arbitrary commands
- **Path traversal** — agents accessing files outside allowed paths
- **Secret leakage** — API keys, tokens, or credentials exposed in logs, events, or subprocess environments
- **Authentication bypass** — accessing API endpoints without valid credentials when auth is enabled
- **Privilege escalation** — agents or API clients gaining capabilities beyond their configuration
- **Denial of service** — inputs that crash the orchestrator or consume unbounded resources

## Security Architecture

OpenPolpo includes several built-in security measures:

### Agent Sandboxing

- **Filesystem sandbox** (`allowedPaths`) — restricts agent file access to configured directories. Agents cannot read or write outside the sandbox. See the [Security Guide](https://polpo.sh/guides/security/).
- **`safeEnv`** — strips sensitive environment variables (API keys, tokens, passwords) from agent subprocess environments. Only explicitly allowed variables are forwarded.

### Network

- **Localhost-only binding** — the HTTP server binds to `127.0.0.1` by default. Remote access requires explicit `--host 0.0.0.0` configuration.
- **API key authentication** — optional API key requirement for all authenticated endpoints.
- **CORS** — restricted to localhost origins by default; configurable for production deployments.

### Condition Evaluation

- **No `eval()`** — notification conditions use a JSON-based DSL with path resolution, not JavaScript eval. Approval gate conditions use a sandboxed `new Function()` with limited scope.

### Data Handling

- **No telemetry** — OpenPolpo does not phone home or collect any usage data.
- **Local-only persistence** — all data (tasks, approvals, logs, sessions) is stored locally in `.polpo/`.

## Known Limitations

- **Approval gate conditions** use `new Function()` for expression evaluation. While the scope is limited to the hook payload, this executes user-provided expressions. Only configure approval gate conditions from trusted sources (your own `polpo.json`).
- **Agent subprocesses** run with the same OS-level permissions as the parent process. The filesystem sandbox is application-level only — it does not use OS-level isolation (containers, chroot, etc.).
- **MCP tool servers** are trusted — OpenPolpo connects to configured MCP servers and exposes their tools to agents without additional sandboxing.

## Supported Versions

We provide security fixes for the latest minor release only. We recommend always running the latest version.

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| Older   | No        |
