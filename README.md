# Minecraft CCTV

A self-hosted public camera wall for first-person Mineflayer bots, with a password-protected admin portal for servers you own or are authorized to access.

## Compatibility checked on October 26, 2026

The requested Minecraft Java 26.3 target is configured as the default, but the current published Prismarine packages do **not** provide a dependable end-to-end 26.3 combination:

- `mineflayer` 4.39.0 and its published support information currently list through 26.1.
- `minecraft-data` 3.117.0 contains 26.1; `minecraft-data("26.2")` and `minecraft-data("26.3")` currently return no dataset.
- `prismarine-viewer` 1.33.0 documents support through 26.1.

The admin portal therefore lets you configure the requested version, but starting a bot fails explicitly when the installed data package cannot support it. For a working setup today, set `MC_VERSION=26.1` and choose `26.1` for each camera. A ViaVersion-enabled server can be another route if it is configured to accept the protocol used by the installed bot packages. Recheck upstream compatibility before moving back to 26.3. Minecraft 26.3 servers require Java 25 as specified in the request; Java is installed on the Minecraft server host, not needed by this Node.js CCTV process.

## Project layout

```text
artifacts/
  api-server/
    src/
      lib/
        admin-session.ts
        bot-manager.ts
        viewer-proxy.ts
      routes/
        bots.ts
        health.ts
      types/
        prismarine-viewer.d.ts
  minecraft-cctv/
    src/                 # React camera wall and /admin portal
lib/
  api-spec/openapi.yaml  # API contract
  api-client-react/      # generated React Query client
  api-zod/               # generated validation schemas
data/                    # runtime bot config and Microsoft session cache (ignored by Git)
.env.example
Caddyfile.local
```

## Local run

Requirements: Node.js 24+, pnpm 10+, and Caddy for the local path proxy. The Minecraft server must be reachable from the machine running the API.

1. Install the workspace packages:

   ```sh
   pnpm install
   ```

2. Create a private local environment file and set unique values for both passwords/secrets:

   ```sh
   cp .env.example .env
   ```

   Replace `ADMIN_PASSWORD` and `SESSION_SECRET` with strong values. Keep `.env` private and out of Git.

3. Run the API server, web app, and local proxy in separate terminals:

   ```sh
   pnpm --filter @workspace/api-server run dev:local
   pnpm --filter @workspace/minecraft-cctv run dev:local
   caddy run --config Caddyfile.local
   ```

4. Open `http://localhost:8080`. The public wall is available without signing in; open `/admin` to sign in and add cameras.

For offline-mode servers, choose **Offline** and use a bot name. Choose **Microsoft** only for an account authorized to join that server; enter its account email, then approve the temporary device sign-in request from the admin portal. The resulting Microsoft session is stored in `data/profiles/`, never in browser storage. Keep the `data/` directory private and back it up securely. When chat is enabled for a bot, players can use the read-only `!cctv status` and `!cctv coords` commands; the owner portal can also send a message to that bot.

Before adding a bot, confirm that you own the target server or have explicit permission to connect a bot. Do not use camera bots on public servers without permission.

## Deploy on a VPS

This application needs a continuously running Node.js process for bot connections and per-camera viewers. Do not deploy the bot process to Vercel/serverless functions.

1. Use a Linux VPS with Node.js 24+, pnpm 10+, and a reachable Minecraft server. If the Minecraft server is on the same host for Java 26.3, install Java 25 there.
2. Clone the project, install dependencies, and build both services:

   ```sh
   corepack enable
   pnpm install --frozen-lockfile
   pnpm --filter @workspace/api-server run build
   pnpm --filter @workspace/minecraft-cctv run build
   ```

3. Create a root `.env` based on `.env.example`. Set `NODE_ENV=production`, a strong `ADMIN_PASSWORD`, and a unique random `SESSION_SECRET`. Use `MC_VERSION=26.1` until the compatibility check above changes. Keep `.env` and `data/` readable only by the service account.
4. Run the API continuously with systemd. Example unit (adjust paths/user for your VPS):

   ```ini
   [Unit]
   Description=Minecraft CCTV API and bot manager
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=mc-cctv
   WorkingDirectory=/opt/minecraft-cctv
   ExecStart=/usr/bin/pnpm --filter @workspace/api-server run start
   Restart=always
   RestartSec=5
   NoNewPrivileges=true
   PrivateTmp=true

   [Install]
   WantedBy=multi-user.target
   ```

   The API reads `.env` from the project root when launched through its pnpm script. Persist `/opt/minecraft-cctv/data/` across restarts and upgrades.

5. Serve the built frontend with Nginx and proxy `/api/` to the API on loopback. Preserve the `/api` path and allow WebSocket upgrades:

   ```nginx
   server {
       listen 80;
       server_name cctv.example.com;
       root /opt/minecraft-cctv/artifacts/minecraft-cctv/dist/public;
       index index.html;

       location /api/ {
           proxy_pass http://127.0.0.1:5000;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
       }

       location / {
           try_files $uri $uri/ /index.html;
       }
   }
   ```

   Add HTTPS before exposing the admin login. Open only the public web ports (80/443). The viewer binds one port per active bot starting at `VIEWER_PORT_START` (default 3200); firewall that range from the public internet. Bot connections are outbound to the Minecraft server.

6. Start the unit, reload Nginx, and visit the public domain. Use `/admin` for bot setup. Keep the VPS logs available for connection diagnostics.

## Common errors

- **“Version is not available in minecraft-data”** — the bot package cannot construct a protocol dataset for that version. Use a version shown in the admin configuration (currently 26.1), or update all three Prismarine packages after upstream 26.3 support is published. `MC_VERSION` is the default only; each saved camera also has its own version.
- **Version mismatch / kicked on join** — the server and bot protocol do not agree. Confirm the exact server version, use the same supported version, or configure ViaVersion to accept the bot’s protocol.
- **Offline login rejected** — offline auth only works when the Minecraft server permits offline-mode accounts. For online-mode servers, select Microsoft auth and authorize an account that can join.
- **Microsoft sign-in does not finish** — approve the temporary device code promptly, verify the server has outbound HTTPS access, and keep `data/profiles/` writable and private.
- **Viewer does not load** — the bot must reach `online`/spawn first. Check that `/api/cameras/<id>/viewer/` ends with a slash, that the API can reach its local viewer port, and that Nginx forwards WebSockets. The first-person renderer also needs a browser with WebGL enabled.
- **Connection timeout / refused** — confirm the Minecraft hostname and port, server firewall, and outbound network access from the API host.
- **Admin login is unavailable** — set both `ADMIN_PASSWORD` and `SESSION_SECRET` in the server environment. Never put either value in frontend code or commit `.env`.
- **Viewer port conflict** — choose a different `VIEWER_PORT_START` and ensure the configured range is free and firewalled.

## Useful commands

```sh
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/minecraft-cctv run typecheck
```
