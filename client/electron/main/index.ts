import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { join, resolve } from "node:path";
import { onCaptionsEvent, startCaptionsSidecar, stopCaptionsSidecar } from "./captions";
import { clearToken, getServerBase, getToken, setServerBase, setToken } from "./server";

const isDev = !app.isPackaged;

// Force CPU-side compositing. Chromium's GPU compositor on this Win11 setup
// silently fails to paint frameless+transparent BrowserWindows (cursor
// hit-test still works, no pixels render). Disabling hardware acceleration
// switches to the software compositor, which handles layered windows
// reliably and lets us keep the original pill-floats-over-desktop look.
app.disableHardwareAcceleration();


let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
// Desired screen-share visibility, owned by the main process so it's correct
// from the overlay's very first show (not only after the renderer effect runs)
// and survives hide/show. false = undetectable (content protection ON).
let detectable = false;
// Apply the current detectable state to the overlay's content protection.
function applyContentProtection(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setContentProtection(!detectable);
  }
}

function resourcePath(...parts: string[]): string {
  return isDev
    ? resolve(__dirname, "..", "..", "resources", ...parts)
    : resolve(process.resourcesPath, ...parts);
}

function setupTray(): void {
  const iconPath = resourcePath("icons", "tray-16.png");
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip("Brandon — live interview assistant");
  const refresh = () => {
    const overlayVisible = !!overlayWindow && overlayWindow.isVisible();
    const menu = Menu.buildFromTemplate([
      { label: "Show Brandon", click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      {
        label: overlayVisible ? "Hide overlay" : "Show overlay",
        accelerator: "CmdOrCtrl+`",
        click: () => {
          if (!overlayWindow) return;
          if (overlayWindow.isVisible()) overlayWindow.hide();
          else overlayWindow.show();
        },
      },
      { type: "separator" },
      { label: "Clear transcript", accelerator: "CmdOrCtrl+Shift+`", click: () => send(overlayWindow, "hotkey", { type: "clear-transcript" }) },
      { label: "Trigger Assist", accelerator: "CmdOrCtrl+Return", click: () => send(overlayWindow, "hotkey", { type: "trigger-chat" }) },
      { type: "separator" },
      { label: "Quit Brandon", click: () => { quitting = true; app.quit(); } },
    ]);
    tray!.setContextMenu(menu);
  };
  refresh();
  tray.on("click", () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  if (overlayWindow) {
    overlayWindow.on("show", refresh);
    overlayWindow.on("hide", refresh);
  }
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    resizable: true,
    maximizable: true,
    show: false,
    title: "Brandon",
    icon: resourcePath("icons", "icon.ico"),
    // styles.css makes body/html transparent (needed for the frameless overlay
    // window which shares the stylesheet). Force the main window's underlying
    // surface to opaque white so the sidebar and chat panel render visibly.
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      sandbox: false,
      // Packaged Brandon loads the renderer from file:// which Chromium treats
      // as a separate origin from http://127.0.0.1, blocking cross-origin
      // fetches to the bundled server. Brandon only loads first-party content
      // we ship ourselves, so disabling webSecurity is safe here.
      webSecurity: false,
    },
  });
  win.on("ready-to-show", () => win.show());
  win.on("close", (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/main/index.html`);
  } else {
    win.loadFile(join(__dirname, "..", "renderer", "main", "index.html"));
  }
  return win;
}

function createOverlayWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 560,
    height: 460,
    minWidth: 420,
    minHeight: 320,
    x: Math.max(0, Math.round((1920 - 560) / 2)),
    y: 24,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      sandbox: false,
      // See createMainWindow — needed so the renderer can fetch the bundled
      // loopback server when loaded from file:// in packaged builds.
      webSecurity: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // setContentProtection(true) (WDA_EXCLUDEFROMCAPTURE on Windows /
  // NSWindowSharingNone on macOS) hides the window from screen-share — Brandon's
  // "undetectable" feature. Apply the main process's desired state immediately
  // (default undetectable) so it's correct from the first show, not only after
  // the renderer's effect runs.
  win.setContentProtection(!detectable);
  // Overlay always captures mouse — needed so the user can drag the window from
  // the title pill / card body and grab the resize corner. Click-through isn't
  // worth the cost in usability for this small overlay.

  // Re-apply on every show/restore/focus: content protection (and always-on-top)
  // can get dropped when the OS hides/re-shows the window, which is exactly when
  // screen-share leaks would happen.
  const reapply = () => {
    win.setAlwaysOnTop(true, "screen-saver");
    win.setContentProtection(!detectable);
  };
  win.on("show", reapply);
  win.on("restore", reapply);
  win.on("focus", reapply);

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay/index.html`);
  } else {
    win.loadFile(join(__dirname, "..", "renderer", "overlay", "index.html"));
  }
  return win;
}

function send(target: BrowserWindow | null, channel: string, payload: unknown): void {
  if (target && !target.isDestroyed()) target.webContents.send(channel, payload);
}

app.whenReady().then(async () => {
  // No local server to spawn anymore — Brandon connects to a remote/local
  // multi-tenant server. The renderer's login screen handles connectivity; the
  // app launches regardless so the user can fix the server URL if it's wrong.
  mainWindow = createMainWindow();
  overlayWindow = createOverlayWindow();
  // Overlay starts hidden — the main window's Start button reveals it.

  globalShortcut.register("CommandOrControl+Return", () => {
    send(overlayWindow, "hotkey", { type: "trigger-chat" });
    if (overlayWindow && !overlayWindow.isVisible()) overlayWindow.show();
  });
  globalShortcut.register("CommandOrControl+`", () => {
    if (!overlayWindow) return;
    if (overlayWindow.isVisible()) overlayWindow.hide();
    else overlayWindow.show();
  });
  globalShortcut.register("CommandOrControl+Shift+`", () => {
    send(overlayWindow, "hotkey", { type: "clear-transcript" });
  });

  // Config: the configurable server URL (no apiKey — auth is a JWT now).
  ipcMain.handle("brandon:config", () => ({ serverBase: getServerBase() }));
  ipcMain.on("brandon:set-server-base", (_e, url: string) => setServerBase(url));
  // JWT storage (OS-keychain via safeStorage in server.ts).
  ipcMain.handle("brandon:get-token", () => getToken());
  ipcMain.on("brandon:set-token", (_e, token: string) => setToken(token));
  ipcMain.on("brandon:clear-token", () => clearToken());

  ipcMain.on("overlay:set-mouse-passthrough", (_e, passthrough: boolean) => {
    if (!overlayWindow) return;
    overlayWindow.setIgnoreMouseEvents(passthrough, { forward: true });
  });

  ipcMain.on("overlay:focus", () => {
    if (overlayWindow) overlayWindow.focus();
  });

  ipcMain.on("overlay:set-size", (_e, size: { width: number; height: number }) => {
    if (!overlayWindow) return;
    const w = Math.max(540, Math.round(size.width));
    const h = Math.max(120, Math.min(900, Math.round(size.height)));
    const [curW, curH] = overlayWindow.getSize();
    if (curW !== w || curH !== h) overlayWindow.setSize(w, h, false);
  });

  // Save the user's exact expanded bounds when collapsing so expanding restores
  // pixel-perfectly — no center-math drift, no surprise repositioning.
  let savedExpandedBounds: Electron.Rectangle | null = null;
  ipcMain.on("overlay:set-collapsed", (_e, collapsed: boolean) => {
    if (!overlayWindow) return;
    if (collapsed) {
      savedExpandedBounds = overlayWindow.getBounds();
      const cur = savedExpandedBounds;
      const w = 260, h = 56;
      overlayWindow.setBounds({
        x: cur.x + Math.round((cur.width - w) / 2),
        y: cur.y,
        width: w,
        height: h,
      });
    } else if (savedExpandedBounds) {
      overlayWindow.setBounds(savedExpandedBounds);
      savedExpandedBounds = null;
    }
  });

  ipcMain.on("overlay:hide", () => {
    if (overlayWindow) overlayWindow.hide();
  });

  ipcMain.on("overlay:show", () => {
    if (!overlayWindow) return;
    if (!overlayWindow.isVisible()) overlayWindow.show();
    overlayWindow.focus();
  });

  ipcMain.on("main:show", () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    // Tell the renderer to refresh sessions so a just-ended meeting appears.
    send(mainWindow, "main:refresh", { reason: "shown" });
  });

  ipcMain.on("main:hide", () => {
    if (mainWindow) mainWindow.hide();
  });

  ipcMain.on("settings:set-detectable", (_e, value: boolean) => {
    // Remember it in the main process so it's re-applied on every overlay
    // show/restore/focus, even if the overlay isn't created yet.
    detectable = value;
    applyContentProtection();
  });

  // Resume conversation flow: main window sends a set of prior turns; we
  // forward them to the overlay and bring it to front. The overlay's
  // useEffect picks up the "resume:turns" event and hydrates state.
  ipcMain.on("overlay:resume", (_e, turns: unknown) => {
    if (!overlayWindow) return;
    send(overlayWindow, "resume:turns", turns);
    if (!overlayWindow.isVisible()) overlayWindow.show();
    overlayWindow.focus();
  });

  onCaptionsEvent((event) => {
    send(overlayWindow, "captions", event);
  });
  startCaptionsSidecar();

  setupTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // Keep the app alive when windows close — tray icon stays.
});

app.on("before-quit", () => { quitting = true; });

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopCaptionsSidecar();
});
