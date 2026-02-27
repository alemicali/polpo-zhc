# Polpo Deployment Guide

## PM2 (Recommended - Linux/macOS/Windows)

PM2 is a cross-platform process manager for Node.js.

1. Install: `npm i -g pm2`
2. Create `ecosystem.config.js`:
```js
module.exports = {
  apps: [{
    name: 'polpo',
    script: 'npx',
    args: '@lumea-labs/polpo serve --dir /path/to/project --port 3000 --api-key YOUR_KEY',
    cwd: '/path/to/project',
    env: { NODE_ENV: 'production' },
    instances: 'max',
    exec_mode: 'cluster'
  }]
};
```
3. Start: `pm2 start ecosystem.config.js`
4. Save: `pm2 save` `pm2 startup`

## Systemd (Linux)

Create `/etc/systemd/system/polpo.service`:
```ini
[Unit]
Description=Polpo Server
After=network.target

[Service]
Type=simple
User=polpo
WorkingDirectory=/path/to/project
ExecStart=/usr/bin/env npx @lumea-labs/polpo serve --dir /path/to/project --port 3000 --api-key YOUR_KEY
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

`sudo systemctl daemon-reload` `sudo systemctl enable --now polpo`

## macOS (Launchd)

Create `~/Library/LaunchAgents/io.polpo.server.plist`:
```xml
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key>
  <string>io.polpo.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>npx</string>
    <string>openpolpo</string>
    <string>serve</string>
    <string>--dir</string>
    <string>/path/to/project</string>
    <string>--port</string>
    <string>3000</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/project</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

`launchctl load ~/Library/LaunchAgents/io.polpo.server.plist`

## Windows (NSSM)

1. Download [NSSM](https://nssm.cc/)
2. `nssm install PolpoServer`
3. Path: `npx`, Args: `@lumea-labs/polpo serve --dir C:\path\to\project --port 3000`
4. Start: `nssm start PolpoServer`

## Multi-Arch Notes

- Node.js binaries support x64/arm64 (Linux/macOS/Windows).
- `better-sqlite3` prebuilts for most arch; `pnpm install` rebuilds if needed.
- Use Docker for full portability:
```dockerfile
FROM node:20-alpine
RUN npm i -g @lumea-labs/polpo
WORKDIR /app
CMD [\"npx\", \"openpolpo\", \"serve\", \"--dir\", \".\", \"--port\", \"3000\"]
```

Verify with `./node_modules/.bin/tsc` after changes.