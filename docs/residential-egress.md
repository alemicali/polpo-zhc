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
- A sandbox network rule keeps its own proxy, which takes precedence. A browser running in a one-run
  remote sandbox (Daytona, E2B) is outside the tailnet and goes out from there; a remote **computer**
  can join the tailnet itself (next section).
- Remote DNS: with SOCKS5, Chromium resolves names through the proxy, so sites see the home line's location.

## Remote computers (Daytona, E2B) through Tailscale

A remote computer's browser runs in its VM, which is not in your tailnet. With `settings.tailscale`
the VM joins the tailnet itself, as a tagged node that may reach the proxy port and nothing else,
and its browser goes out through the same home proxy.

```
browser in the VM ──socks5──▶ 127.0.0.1:1081 (forwarder) ──socks5 CONNECT──▶ 127.0.0.1:1055 (tailscaled, userspace)
                                                                                 │ tailnet (WireGuard, direct or DERP)
                                                                                 ▼
                                                                  ahp0 100.101.55.7:1080 (microsocks) ──▶ internet
```

In the VM (all under `/tmp/polpo-tailnet`, mode 0700):

- `tailscale` / `tailscaled` 1.104.7: in the runner images (`scripts/build-sandbox-images.mjs`: Daytona
  v0 snapshot, E2B template, and the Daytona v2 image `polpo-runner-vm-2`); otherwise downloaded on
  first use from `pkgs.tailscale.com` and checked against a pinned SHA-256. Computers run on Daytona
  v0 (containers), E2B and Daytona v2 (Linux VMs that hibernate: their memory snapshot keeps
  tailscaled running, and every wake checks the tailnet again: when the ephemeral node was removed
  meanwhile, `tailscale up` runs again with the key).
- `tailscaled --tun=userspace-networking --socks5-server=127.0.0.1:1055 --state=mem:`: no TUN device,
  no root; the state is in memory, so the node leaves with the VM (ephemeral key).
- `tailscale up --auth-key=file:… --hostname=<prefix>-<project>-<computer> --advertise-tags=… --accept-dns=false`.
  The key is read from the vault by the server (or the task runner), uploaded through the provider's
  file API into a 0600 file, and deleted right after `up`, whatever its result. It is never on a
  command line, in an environment variable or in a log (command output is masked).
- A small Node forwarder on `127.0.0.1:1081`: every connection becomes a SOCKS5 CONNECT to the proxy
  through tailscaled, then plain bytes, so `1081` behaves as the proxy itself and the browser runs with
  `--proxy socks5://127.0.0.1:1081`.

It comes up when the computer starts or resumes (in the background) and, in any case, before the
browser's next command; one command checks it while everything runs (cached 30 s). After a resume or a
container restart the daemons are started again if they died. Resetting or deleting the computer runs
`tailscale logout` first (best effort; an ephemeral node also disappears by itself). The rules above
apply as on the server: proxy unreachable → directly from the VM, except a profile signed in through the
proxy, which pauses; the browser restarts when the proxy it should use changes.

### 1. Tailscale admin console

Tag owner and ACL (Access controls). The sandboxes may reach the proxy port, nothing else:

```jsonc
{
  "tagOwners": {
    "tag:polpo-sandbox": ["autogroup:admin"]
  },
  "acls": [
    // the Polpo server (already there for host browsers)
    { "action": "accept", "src": ["lumea-dev"], "dst": ["ahp0:1080"] },
    // remote computers: only the home proxy
    { "action": "accept", "src": ["tag:polpo-sandbox"], "dst": ["ahp0:1080"] }
  ]
}
```

(With the newer `grants` syntax: `{ "src": ["tag:polpo-sandbox"], "dst": ["ahp0"], "ip": ["tcp:1080"] }`.)
Nothing allows traffic *to* `tag:polpo-sandbox`, so the tailnet cannot reach into the VMs.

Auth key (Settings → Keys → Generate auth key): **Reusable** (every computer, every restart),
**Ephemeral** (nodes are removed when they go offline), **Pre-approved**, tag **`tag:polpo-sandbox`**,
and an expiry you are comfortable rotating (the key is used only to join; rotating it means updating the
vault entry).

### 2. The key in the vault

Store it in a vault entry whose owner is **not** an agent that works on the computer (an agent could read
its own entries from its sandbox), e.g. owner `polpo-infra`, service `tailscale-sandbox`, field `authKey`.
Without printing it (here from a file on the Polpo host; the instance's REST API and an API key):

```bash
URL=http://127.0.0.1:3001            # the instance
read -rsp "Polpo API key: " POLPO_KEY; echo
jq -n --rawfile k ~/deploy/tailscale-sandbox.key \
  '{agent: "polpo-infra", service: "tailscale-sandbox", type: "api_key",
    label: "Tailscale auth key for remote computers (ephemeral, reusable, tag:polpo-sandbox)",
    credentials: {authKey: ($k | rtrimstr("\n"))}}' \
| curl -sS -X POST "$URL/api/v1/vault/entries" -H "authorization: Bearer $POLPO_KEY" \
    -H "content-type: application/json" --data-binary @- | jq '{ok, keys: .data.keys}'
# expect {"ok": true, "keys": ["authKey"]}; then remove the file: shred -u ~/deploy/tailscale-sandbox.key
```

### 3. Settings

```json
"settings": {
  "egressProxies": { "home": "socks5://100.101.55.7:1080" },
  "tailscale": {
    "authKey": { "owner": "polpo-infra", "service": "tailscale-sandbox" },
    "tags": ["tag:polpo-sandbox"],
    "hostnamePrefix": "polpo-sbx"
  }
}
```

`tags` (default `["tag:polpo-sandbox"]`) must be allowed by the key; `hostnamePrefix` (default `polpo-sbx`)
names the nodes `<prefix>-<project>-<computer>`, e.g. `polpo-sbx-lumea-nina`. Through the API:
`PATCH /api/v1/config/settings {"tailscale": {...}}` (`null` removes it; refused while a remote computer
still goes out through Tailscale). The key itself is never accepted there, only its vault reference.

### 4. The computer

```bash
curl -sS -X PATCH "$URL/api/v1/computers/nina" -H "authorization: Bearer $POLPO_KEY" \
  -H "content-type: application/json" -d '{"egress": "home"}'
```

Refused, with the reason, unless `settings.tailscale` is set, the proxy is SOCKS5 (`socks5://` or
`socks5h://`) on a tailnet address (100.64.0.0/10 or a MagicDNS name such as `ahp0` /
`ahp0.<tailnet>.ts.net`), and the computer has a network (not `deny`). HTTP proxies are not supported
for remote computers yet. The VM needs to reach Tailscale's coordination and DERP servers: use network
`open` (an allowlist would have to include Tailscale's hosts, which are not stable names).

### Status

- `GET /api/v1/computers/nina/egress`: `tailnet` (`up`, `down`, `starting`, or `off` when the computer is
  not running: it never starts it to look), `node`, `tailnetIp`, `path` (`direct` or `derp`, with `relay`,
  the DERP region), `proxyReachable`, `effective` (where its browser goes out now), `error`.
- Polpo's `egress_status` lists the same for every remote computer with an egress.

### Latency

From a cloud VM to a machine at home behind NAT, Tailscale usually cannot punch a direct path and relays
through **DERP** (the nearest region of both ends): expect tens to a couple of hundred milliseconds more
per round trip, and DERP's throughput. Pages load slower than from the server; it is fine for browsing,
not for bulk downloads. `path: "direct"` appears when a direct UDP path was found (e.g. the home router
allows it, or UPnP/NAT-PMP is on).

### Troubleshooting

| Symptom | Look at |
|---|---|
| `No Tailscale auth key in the vault entry …` | The entry exists, with a field named `authKey` (or `key`, `token`). |
| `tailscale up failed: … invalid key` / `requested tags … are invalid or not permitted` | The key expired or was revoked; the key's tags and `settings.tailscale.tags` must match, and `tagOwners` must list the tag. |
| `tailnet up`, `proxyReachable: false` | The home machine or `microsocks` is off, or the ACL lacks `tag:polpo-sandbox → ahp0:1080`. From the VM: `/tmp/polpo-tailnet/bin/tailscale --socket=/tmp/polpo-tailnet/tailscaled.sock ping 100.101.55.7` (or `tailscale` if in PATH). |
| `Tailscale could not be installed in the VM` | The VM has no network to `pkgs.tailscale.com` (network rule), or an unsupported architecture. Rebuild the runner image so it is preinstalled. |
| `tailscaled could not start` | `/tmp/polpo-tailnet/tailscaled.log` in the VM. |
| Several nodes `polpo-sbx-…-nina-1`, `-2` in the admin console | Earlier nodes of the same computer that have not expired yet (ephemeral nodes go after being offline a while); harmless. |
| The browser keeps saying "paused" | Its profile was used through the proxy and the proxy is unreachable: bring the home machine back, or clear the profile (`browser_profile_clear`) to let it go out directly. |
