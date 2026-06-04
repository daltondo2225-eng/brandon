# Brandon

Live interview AI assistant. A Cluely-style Electron overlay that:

- Reads the interviewer's words from Windows 11 **Live Captions** (no in-house ASR)
- Holds multiple profiles, each with its own real-time prompt and reference files (resume, JD, PDFs)
- Streams Claude responses (bullets + first-person speaking script) on `Ctrl+Enter`
- Floats invisibly over Zoom/Meet/Teams — the overlay window is hidden from screen capture

## Architecture

- **`server/`** — Fastify + Node 24 `node:sqlite`. Profiles + file uploads + `POST /chat` SSE.
- **`client/`** — Electron + React. Main window (profile manager) and frameless content-protected overlay window.
- **`sidecar/BrandonCaptions/`** — .NET 8 console app using FlaUI.UIA3. Reads the Windows Live Captions text via UI Automation and emits NDJSON deltas on stdout.
- **`shared/src/types.ts`** — Cross-package TypeScript types.

## First-time setup

Requires: **Node 22+** (24 recommended), **.NET 8 SDK** (only for rebuilding the captions sidecar).

```powershell
# 1. Install all workspace deps
npm install

# 2. Copy env template and fill in your Anthropic key
Copy-Item .env.example .env
notepad .env   # set ANTHROPIC_API_KEY=sk-ant-...

# 3. (Optional) Publish the C# captions sidecar — already shipped pre-built in client/resources/bin
npm run publish:sidecar
```

## Daily use (dev mode)

```powershell
npm run dev
```

Launches server + Electron + captions sidecar together. Two windows appear:

- **Brandon** main window — sidebar of modes, profile editor on the right.
- **Brandon overlay** — top-centre, frameless, click-through unless hovered. Invisible to screen-share.

Tray icon (system tray, bottom-right) gives you Show/Hide overlay, Trigger Assist, Clear transcript, Quit.

## Hotkeys

| Hotkey            | What it does                                 |
|-------------------|----------------------------------------------|
| `Ctrl+Enter`      | Run **Assist** (stream a response).          |
| `` Ctrl+` ``      | Toggle overlay visibility.                   |
| `` Ctrl+Shift+` ``| Clear the rolling transcript and response.   |

## Using it in an interview

1. Open Brandon's main window. Create a profile (e.g. "Dalton"), paste a real-time prompt, upload resume + JD PDFs, click **Save**, click **Set Active**.
2. Press **Win+Ctrl+L** to start Windows Live Captions (the OS feature). The overlay's mic icon turns red when captions are flowing.
3. Join the Zoom/Meet/Teams call. Share screen if you want — the overlay stays hidden.
4. Tap a chip (**Assist**, **What should I say?**, **Follow-up questions**, **Recap**) or press **Ctrl+Enter**.
5. Bullets stream into the response area as Claude generates them, followed by a first-person speaking script.

## Packaging a Windows installer

```powershell
npm run dist
```

Output: `client/release/Brandon-Setup-<version>.exe`. The captions sidecar and icons are bundled via `extraResources`.

> Note: the **server** is not currently embedded in the installer — start it separately with `npm run dev:server` until that's wired in. Single-binary packaging is on the polish list.

## Configuration

`.env` at the repo root:

| Variable                  | Default | Notes                                                                  |
|---------------------------|---------|------------------------------------------------------------------------|
| `ANTHROPIC_API_KEY`       | —       | Required.                                                              |
| `BRANDON_API_KEY`         | auto    | Local API key. Auto-generated on first server boot if missing.         |
| `PORT`                    | 8787    | Server listen port (loopback only).                                    |
| `BRANDON_EXTENDED_CACHE`  | `true`  | Opt into Anthropic's 1-hour prompt-cache TTL beta.                     |

## Storage

- `server/data/brandon.db` — SQLite database (profiles, files, sessions).
- `server/data/uploads/<profile-id>/<file-id>_<name>` — original uploaded files.

## Privacy

Everything runs locally. The only outbound network call is to `api.anthropic.com` when you trigger Assist. Profile docs, transcript text, and the active prompt are sent as part of each Claude request.
