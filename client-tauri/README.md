# Brandon — Tauri client

A Tauri (Rust + native webview) replacement for the Electron client in
[`../client`](../client). Same React UI, same server, same captions sidecar —
but a tiny native shell instead of bundling Chromium, and a cross-platform
build (macOS `.app`/`.dmg` + Windows `.msi`/NSIS).

## Why this exists

The Electron client works, but packaging/signing was painful and it ships
~100 MB of Chromium. Tauri reuses the OS webview (WKWebView on macOS, WebView2
on Windows), so the installer is a few MB and the build pipeline is simpler.

The migration is deliberately **surgical**: the entire React UI was copied over
unchanged. The only frontend file that differs is [`src/lib/bridge.ts`](src/lib/bridge.ts),
which now routes through Tauri's `invoke`/`listen` instead of Electron's
`contextBridge`. Because the components only ever touch the platform through
`bridge` + `getConfig()`, nothing else had to change.

## Architecture

```
┌─────────────────────────── Rust shell (src-tauri) ───────────────────────────┐
│  lib.rs        commands + windows + hotkeys + tray + content protection        │
│  server.rs     spawn/locate the bundled Node server, wait for /health          │
│  captions.rs   spawn .NET captions sidecar, relay NDJSON → `captions` event    │
└───────────────────────────────────────────────────────────────────────────────┘
        │ invoke (commands)              │ emit (events: captions / hotkey / main:refresh)
        ▼                                ▼
┌──────────────────────── React webview (src) ─────────────────────────────────┐
│  main/App.tsx        profiles · sessions · pipeline · agenda (window "main")    │
│  overlay/OverlayApp  live transcript + streaming response (window "overlay")    │
│  lib/bridge.ts       Tauri shim — same surface the Electron preload exposed     │
│  lib/api.ts          HTTP/SSE client to the Fastify server (unchanged)          │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Command / event parity with Electron

Every old `window.brandon.*` call maps to a Tauri command of the same intent,
and every old `ipcRenderer.send(channel, …)` from main→renderer maps to a Tauri
event with the same channel name:

| Electron preload          | Tauri command (`invoke`)        |
| ------------------------- | ------------------------------- |
| `getConfig()`             | `get_config`                    |
| `setMousePassthrough`     | `overlay_set_mouse_passthrough` |
| `focusOverlay`            | `overlay_focus`                 |
| `setOverlaySize`          | `overlay_set_size`              |
| `setOverlayCollapsed`     | `overlay_set_collapsed`         |
| `hideOverlay`/`showOverlay` | `overlay_hide`/`overlay_show` |
| `showMainWindow`/`hideMainWindow` | `main_show`/`main_hide` |
| `setDetectable`           | `settings_set_detectable`       |

| Electron channel (main→renderer) | Tauri event       |
| -------------------------------- | ----------------- |
| `captions`                       | `captions`        |
| `hotkey`                         | `hotkey`          |
| `main:refresh`                   | `main:refresh`    |

## Develop

```bash
# from the repo root — runs the dev server + the Tauri app together
npm run dev:tauri
```

In dev the Rust side does **not** spawn the server; it reads `../.env`
(`BRANDON_API_KEY`, `PORT`) and points the webview at your externally-running
`npm run dev:server`, exactly like the Electron dev flow. The Vite dev server
runs on port **1420** (`tauri.conf.json` → `build.devUrl`).

## Build / package

```bash
# from the repo root — stages the Node server, then bundles the native app
npm run dist:tauri
```

This:
1. Bundles the Fastify server into `src-tauri/server/` (esbuild + prod
   `npm install`), via `scripts/package-server.mjs --out=…`.
2. Compiles the Rust shell in release mode and runs the Tauri bundler.

Output lands in `src-tauri/target/release/bundle/` (`.app` + `.dmg` on macOS,
NSIS `.exe` / `.msi` on Windows).

> `npm run dist:tauri` builds the server as a **standalone executable**
> (`brandon-server[.exe]`, via Node SEA — see `scripts/build-server-sea.mjs`)
> and ships it under `resources/bin/`. The target machine needs **no Node
> installed**. At runtime `server.rs` prefers that binary and falls back to
> `node dist/index.mjs` only if it's absent (e.g. dev machines).

## Platform notes

- **Screen-share invisibility** uses `set_content_protected(true)` — the macOS
  (`NSWindowSharingNone`) and Windows (`SetWindowDisplayAffinity`) analogue of
  the Electron `setContentProtection`. Toggle it from the main window's
  "detectable" switch (`settings_set_detectable`).
- **Overlay transparency** requires `app.macOSPrivateApi: true` in
  `tauri.conf.json` (and the matching `macos-private-api` Cargo feature). This
  is enabled.
- **Captions** is Windows-only — it reads Windows 11 Live Captions via the .NET
  `BrandonCaptions.exe` sidecar (copy it into `src-tauri/bin/` before a Windows
  build). On macOS the sidecar is absent; `captions.rs` emits one
  `sidecar-missing` event and the rest of the app (profiles, chat, recaps)
  works for development. A native macOS captions engine is a future project.
- **No console flashing** — the server and captions children are spawned with
  `CREATE_NO_WINDOW` on Windows (`server::hide_console`), so nothing pops a
  black console during an interview. (Electron's `windowsHide: true` equivalent.)

## Building & shipping on Windows

macOS is dev-only; **interviews run on Windows**, so the real release is built
there. Everything below must run **on a Windows machine** (the server `.exe` and
the installer are platform-specific and can't be cross-built from macOS).

### Prerequisites (one time)
- **Rust** (`rustup`, MSVC toolchain) + **Node 22.5+** + **.NET 8 SDK**
- **WebView2 runtime** — preinstalled on Windows 11 (your captions target), so
  the default Tauri `downloadBootstrapper` install mode is fine. If you ever
  ship to a machine without it, set `bundle.windows.webviewInstallMode` to
  `embedBootstrapper` in `tauri.conf.json`.

### Steps
```powershell
# 1. Build the captions sidecar (.NET) and stage it where Tauri bundles from
dotnet publish sidecar/BrandonCaptions -c Release -r win-x64 `
  --self-contained -p:PublishSingleFile=true -o sidecar/publish
copy sidecar\publish\BrandonCaptions.exe client-tauri\src-tauri\bin\

# 2. Build the standalone server.exe (Node SEA) + bundle the app.
#    dist:tauri runs build:server:tauri (→ bin\brandon-server.exe) then bundles.
npm install
npm run dist:tauri
```

Output: `client-tauri/src-tauri/target/release/bundle/nsis/Brandon_<ver>_x64-setup.exe`

### Post-build test checklist (only verifiable on Windows)
- [ ] Installer runs; app launches; main window shows profiles/sessions
- [ ] Server started with **no console window** flashing
- [ ] Settings → save Anthropic key works (returns "set")
- [ ] Press **Win+Ctrl+L** (Windows Live Captions) → overlay shows live transcript
- [ ] **Screen-share test**: share the screen in Zoom/Meet; the overlay must be
      **invisible** to the other side while visible to you (content protection)
- [ ] Toggle the "detectable" switch → overlay becomes visible in the share
- [ ] Global hotkeys: `Ctrl+Enter` (assist), `` Ctrl+` `` (toggle overlay)
- [ ] Tray icon: show/hide windows, quit

> None of these have been tested from the macOS dev box — the Rust code is
> verified to compile for `x86_64-pc-windows-msvc`, but runtime behavior
> (captions, content protection, installer) must be confirmed on Windows.
```
