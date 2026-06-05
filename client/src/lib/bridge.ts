import type { BrandonBridge } from "../../electron/preload";

declare global {
  interface Window {
    brandon: BrandonBridge;
  }
}

// The server URL lives in the main process (one source of truth, shared by the
// main window + the overlay, which are SEPARATE renderer processes). We do NOT
// cache it in the renderer: a stale per-window cache caused the overlay to keep
// hitting the old base (e.g. localhost) after the URL was changed in the main
// window — "Failed to fetch" during interviews. The IPC read is cheap.
export async function getConfig(): Promise<{ serverBase: string }> {
  return window.brandon.getConfig();
}

/** No-op kept for call sites; config is always read live now. */
export function resetConfigCache(): void { /* config is no longer cached */ }

export const bridge = {
  getToken: window.brandon.getToken,
  setToken: window.brandon.setToken,
  clearToken: window.brandon.clearToken,
  setServerBase: window.brandon.setServerBase,
  onHotkey: window.brandon.onHotkey,
  onCaptions: window.brandon.onCaptions,
  onMainRefresh: window.brandon.onMainRefresh,
  setMousePassthrough: window.brandon.setMousePassthrough,
  focusOverlay: window.brandon.focusOverlay,
  setOverlaySize: window.brandon.setOverlaySize,
  setOverlayCollapsed: window.brandon.setOverlayCollapsed,
  hideOverlay: window.brandon.hideOverlay,
  showOverlay: window.brandon.showOverlay,
  showMainWindow: window.brandon.showMainWindow,
  hideMainWindow: window.brandon.hideMainWindow,
  setDetectable: window.brandon.setDetectable,
  resumeOverlay: window.brandon.resumeOverlay,
  onResumeTurns: window.brandon.onResumeTurns,
};
