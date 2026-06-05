# Deploying Brandon

Brandon is a **thin Windows client** talking to a **remote server**. The server
holds the database, auth, usage, and the (operator-owned) LLM API keys. Users
install the Windows app and, on first run, point it at your server URL.

This guide covers:

1. Run the server
2. Expose it publicly with a **free Cloudflare Tunnel**
3. Build & distribute the **Windows installer** (incl. the captions sidecar)

---

## 1. Run the server

The server needs **Node 22+** (it uses `node:sqlite`).

### Option A — directly (simplest)

```bash
cd server
npm ci
# Required: the LLM keys you pay for, and a first super-admin login.
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GEMINI_API_KEY=AIza...
export BRANDON_SUPERADMIN_EMAIL=you@example.com
export BRANDON_SUPERADMIN_PASSWORD='a-strong-password'
# Recommended in production (otherwise a random secret is generated per data dir):
export BRANDON_JWT_SECRET="$(openssl rand -hex 48)"
export BRANDON_HOST=0.0.0.0      # bind beyond loopback
export PORT=8787
npm run start
```

State (SQLite DB, uploaded files, JWT secret) lives in `server/data/` by
default — set `BRANDON_DATA_DIR` to relocate it. **Back this folder up.**

### Option B — Docker

```bash
# Build from the repo ROOT (workspace + @brandon/shared must resolve):
docker build -f server/Dockerfile -t brandon-server .

docker run -d --name brandon \
  -p 8787:8787 \
  -v brandon-data:/data \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e OPENAI_API_KEY=sk-... \
  -e GEMINI_API_KEY=AIza... \
  -e BRANDON_SUPERADMIN_EMAIL=you@example.com \
  -e BRANDON_SUPERADMIN_PASSWORD='a-strong-password' \
  -e BRANDON_JWT_SECRET="$(openssl rand -hex 48)" \
  brandon-server
```

Verify: `curl http://localhost:8787/health` → `{"ok":true}`.

---

## 2. Expose it with a free Cloudflare Tunnel

A tunnel gives the server a public HTTPS URL without opening any firewall ports
or having a static IP — Cloudflare connects *out* from your machine. Free tier
is plenty for this.

Install `cloudflared`: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>
(macOS: `brew install cloudflared`).

### Quick tunnel (zero config — for testing)

With the server already running on `:8787`:

```bash
cloudflared tunnel --url http://localhost:8787
```

It prints a random URL like `https://random-words.trycloudflare.com`. That's
your server URL — paste it into the app's **Server URL** field on first run.

> ⚠️ The quick-tunnel URL changes every time you restart `cloudflared`. Use a
> **named tunnel** (below) for anything you hand to real users.

### Named tunnel (stable URL — for real use)

Requires a domain on Cloudflare (free plan is fine). One-time setup:

```bash
cloudflared tunnel login                      # opens browser, pick your domain
cloudflared tunnel create brandon             # creates a tunnel + credentials file
cloudflared tunnel route dns brandon api.yourdomain.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: brandon
credentials-file: /home/USER/.cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: api.yourdomain.com
    service: http://localhost:8787
  - service: http_status:404
```

Run it (and keep it running — as a service is best):

```bash
cloudflared tunnel run brandon
# or install as a background service:
sudo cloudflared service install
```

Now `https://api.yourdomain.com` is your permanent server URL.

> The desktop client makes no special CORS demands — it loads from `file://`
> (Origin `null`) / `localhost`, both already allowed. Browsers hitting the API
> from another web origin would need that origin added via
> `BRANDON_ALLOWED_ORIGINS=https://app.example.com`.

---

## 3. Build & distribute the Windows app

The installer bundles the Electron UI **and** the captions sidecar
(`BrandonCaptions.exe`, a self-contained .NET 8 app that reads Windows Live
Captions). Captions + the screen-share-invisible overlay only work on Windows.

### Via GitHub Actions (recommended)

`.github/workflows/windows-build.yml` runs on a `windows-latest` runner:
builds the sidecar (.NET), then the Electron app, then the NSIS installer.

- **Manual:** Actions → *Build Windows installer* → *Run workflow* → download
  the `brandon-windows-installer` artifact.
- **Tagged release:** `git tag v0.1.0 && git push origin v0.1.0` → the `.exe` is
  built and attached to a GitHub Release automatically.

### On a Windows machine

```powershell
# Publish the captions sidecar into client/resources/bin:
pwsh sidecar/publish.ps1
# Build the installer:
npm ci
npm --workspace client run dist
# → client/release/Brandon-Setup-<version>.exe
```

If `resources/bin` is empty (e.g. you build on macOS), the app still installs
and runs — it just shows a "captions unavailable" hint instead of live captions.

### What users do

1. Install via the `.exe`.
2. Launch → enter your **Server URL** (the tunnel URL from step 2) → sign up.
3. New accounts are **pending** until you (the super-admin) approve them in the
   in-app Admin panel.

> Unsigned installers trigger Windows SmartScreen. For a smoother install,
> add a code-signing certificate as a CI secret and configure `win.certificateFile`
> in `client/electron-builder.yml`.
