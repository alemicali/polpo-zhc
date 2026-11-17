# Residential egress for agents' browsers

Some sites block or challenge datacenter IP ranges (Hetzner, AWS…). An agent's browser can go out
to the internet through another machine instead, for example a computer at home on the same
Tailscale network, so sites see a residential address.

Only the **browser** of the agents you choose uses it. Web search and HTTP tools keep their own
providers (Exa, proxy services).

## 1. A proxy on the home machine

On the home computer (Linux, in the tailnet), run a SOCKS5 proxy that listens **only on its
Tailscale address**. It is never reachable from the internet. For example, with `microsocks`:

```bash
sudo apt install -y microsocks
```

Create `/etc/systemd/system/polpo-egress.service` (use the machine's own Tailscale IP, from `tailscale ip -4`):

```ini
[Unit]
Description=SOCKS proxy for Polpo agents' browsers (tailnet only)
After=tailscaled.service
Wants=tailscaled.service

[Service]
ExecStart=/usr/bin/microsocks -i 100.101.55.7 -p 1080
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now polpo-egress
```

In the Tailscale admin console, allow only the Polpo server to reach that port (ACL), for example:

```json
{ "action": "accept", "src": ["lumea-dev"], "dst": ["ahp0:1080"] }
```

## 2. Polpo settings

In `.polpo/polpo.json`, name the proxy:

```json
"settings": { "egressProxies": { "home": "socks5://100.101.55.7:1080" } }
```

Then choose the agents: `browserEgress: "home"` on each (or ask Polpo: "make growth's browser go out from home").
`egress_status` (a Polpo tool) says whether each proxy is reachable and who uses it.

## How it behaves

- **Proxy reachable**: the agent's browser runs behind it. The proxy is set when the browser starts, so a
  browser already running restarts on the same profile, and the logins stay.
- **Proxy unreachable** (the computer is off): the browser goes out directly from the server. The exception
  is a profile that was signed in through the proxy: a logged-in account suddenly seen from another place
  may be flagged, so that profile's browser **pauses** and the agent says so, until the proxy is back.
- A sandbox network rule keeps its own proxy, which takes precedence. A browser running in a remote
  sandbox (Daytona, E2B) is outside the tailnet and goes out from there.
- Remote DNS: with SOCKS5, Chromium resolves names through the proxy, so sites see the home line's location.
