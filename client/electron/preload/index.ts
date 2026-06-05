import { contextBridge, ipcRenderer } from "electron";

export type CaptionsEvent =
  | { type: "status"; captionsRunning: boolean; hint: string | null }
  | { type: "delta"; text: string; full: string }
  | { type: "error"; message: string }
  | { type: "sidecar-missing"; expectedPath: string };

export type HotkeyEvent = { type: "trigger-chat" | "clear-transcript" };

/** A single Q&A turn used by the "resume conversation" flow — matches
 *  the overlay's DisplayTurn shape. Kept here so both renderers can use it. */
export interface ResumeTurn {
  label: string;
  user: string;
  assistant: string;
}

export interface BrandonBridge {
  getConfig(): Promise<{ serverBase: string; apiKey: string }>;
  onHotkey(callback: (event: HotkeyEvent) => void): () => void;
  onCaptions(callback: (event: CaptionsEvent) => void): () => void;
  onMainRefresh(callback: () => void): () => void;
  setMousePassthrough(passthrough: boolean): void;
  focusOverlay(): void;
  setOverlaySize(width: number, height: number): void;
  setOverlayCollapsed(collapsed: boolean): void;
  hideOverlay(): void;
  showOverlay(): void;
  showMainWindow(): void;
  hideMainWindow(): void;
  setDetectable(detectable: boolean): void;
  /** From the main window: send the overlay a set of prior turns to load. */
  resumeOverlay(turns: ResumeTurn[]): void;
  /** From the overlay: subscribe to resume payloads pushed by the main window. */
  onResumeTurns(callback: (turns: ResumeTurn[]) => void): () => void;
}

const bridge: BrandonBridge = {
  getConfig: () => ipcRenderer.invoke("brandon:config"),
  onHotkey: (callback) => {
    const handler = (_e: unknown, event: HotkeyEvent) => callback(event);
    ipcRenderer.on("hotkey", handler);
    return () => ipcRenderer.removeListener("hotkey", handler);
  },
  onCaptions: (callback) => {
    const handler = (_e: unknown, event: CaptionsEvent) => callback(event);
    ipcRenderer.on("captions", handler);
    return () => ipcRenderer.removeListener("captions", handler);
  },
  onMainRefresh: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("main:refresh", handler);
    return () => ipcRenderer.removeListener("main:refresh", handler);
  },
  setMousePassthrough: (passthrough) => ipcRenderer.send("overlay:set-mouse-passthrough", passthrough),
  focusOverlay: () => ipcRenderer.send("overlay:focus"),
  setOverlaySize: (width, height) => ipcRenderer.send("overlay:set-size", { width, height }),
  setOverlayCollapsed: (collapsed) => ipcRenderer.send("overlay:set-collapsed", collapsed),
  hideOverlay: () => ipcRenderer.send("overlay:hide"),
  showOverlay: () => ipcRenderer.send("overlay:show"),
  showMainWindow: () => ipcRenderer.send("main:show"),
  hideMainWindow: () => ipcRenderer.send("main:hide"),
  setDetectable: (detectable) => ipcRenderer.send("settings:set-detectable", detectable),
  resumeOverlay: (turns) => ipcRenderer.send("overlay:resume", turns),
  onResumeTurns: (callback) => {
    const handler = (_e: unknown, turns: ResumeTurn[]) => callback(turns);
    ipcRenderer.on("resume:turns", handler);
    return () => ipcRenderer.removeListener("resume:turns", handler);
  },
};

contextBridge.exposeInMainWorld("brandon", bridge);
