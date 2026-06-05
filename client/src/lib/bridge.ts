import type { BrandonBridge } from "../../electron/preload";

declare global {
  interface Window {
    brandon: BrandonBridge;
  }
}

let _config: { serverBase: string } | null = null;

export async function getConfig(): Promise<{ serverBase: string }> {
  if (_config) return _config;
  _config = await window.brandon.getConfig();
  return _config;
}

/** Force a re-read of the server URL (after the user edits it on the login screen). */
export function resetConfigCache(): void { _config = null; }

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
