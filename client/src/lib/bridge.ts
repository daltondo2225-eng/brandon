import type { BrandonBridge } from "../../electron/preload";

declare global {
  interface Window {
    brandon: BrandonBridge;
  }
}

let _config: { serverBase: string; apiKey: string } | null = null;

export async function getConfig(): Promise<{ serverBase: string; apiKey: string }> {
  if (_config) return _config;
  _config = await window.brandon.getConfig();
  return _config;
}

export const bridge = {
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
};
