// Tauri bridge — reimplements the exact surface the Electron preload used to
// expose on `window.brandon`, but routed through Tauri's invoke (commands) and
// event system. Keeping this surface identical means App.tsx / OverlayApp.tsx
// port over unchanged: they only ever talk to the platform through `bridge`
// and `getConfig()`.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type CaptionsEvent =
  | { type: "status"; captionsRunning: boolean; hint: string | null }
  | { type: "delta"; text: string; full: string }
  | { type: "error"; message: string }
  | { type: "sidecar-missing"; expectedPath: string };

export type HotkeyEvent = { type: "trigger-chat" | "clear-transcript" };

interface ServerConfig { serverBase: string; apiKey: string }

let _config: ServerConfig | null = null;

export async function getConfig(): Promise<ServerConfig> {
  if (_config) return _config;
  // The Rust side starts the bundled server (prod) or reads the dev .env, then
  // returns the loopback base URL + the local auth key.
  _config = await invoke<ServerConfig>("get_config");
  return _config;
}

/**
 * Subscribe to a Tauri event. Tauri's `listen` returns a Promise<UnlistenFn>,
 * but the React components expect a synchronous unsubscribe (they call it in a
 * useEffect cleanup). We bridge that by capturing the unlisten fn once it
 * resolves and invoking it on teardown.
 */
function subscribe<T>(event: string, callback: (payload: T) => void): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  listen<T>(event, (e) => callback(e.payload)).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    if (unlisten) unlisten();
  };
}

export const bridge = {
  onHotkey: (callback: (event: HotkeyEvent) => void) =>
    subscribe<HotkeyEvent>("hotkey", callback),

  onCaptions: (callback: (event: CaptionsEvent) => void) =>
    subscribe<CaptionsEvent>("captions", callback),

  onMainRefresh: (callback: () => void) =>
    subscribe<unknown>("main:refresh", () => callback()),

  setMousePassthrough: (passthrough: boolean) =>
    void invoke("overlay_set_mouse_passthrough", { passthrough }),

  focusOverlay: () => void invoke("overlay_focus"),

  setOverlaySize: (width: number, height: number) =>
    void invoke("overlay_set_size", { width, height }),

  setOverlayCollapsed: (collapsed: boolean) =>
    void invoke("overlay_set_collapsed", { collapsed }),

  hideOverlay: () => void invoke("overlay_hide"),

  showOverlay: () => void invoke("overlay_show"),

  showMainWindow: () => void invoke("main_show"),

  hideMainWindow: () => void invoke("main_hide"),

  setDetectable: (detectable: boolean) =>
    void invoke("settings_set_detectable", { detectable }),
};
