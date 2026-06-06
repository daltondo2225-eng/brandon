// Overlay appearance preferences — persisted to localStorage, tuned live from
// the in-overlay gear popover. Kept deliberately minimal: just Theme + Opacity.
import { useCallback, useEffect, useState } from "react";

// dark = the current dark glass; light = white background, black text.
export type OverlayTheme = "dark" | "light";

export interface OverlayPrefs {
  fontSize: number;   // px, 12–32 (still adjustable via the A−/A+ buttons)
  theme: OverlayTheme;
  opacity: number;    // 0.30–1.00 — overlay background alpha ("capacity")
}

export const THEMES: { id: OverlayTheme; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];

const DEFAULTS: OverlayPrefs = { fontSize: 18, theme: "dark", opacity: 0.82 };

const KEY = "brandon.overlayPrefs";

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function load(): OverlayPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<OverlayPrefs>;
      return {
        fontSize: clamp(Number(p.fontSize) || DEFAULTS.fontSize, 12, 32),
        theme: THEMES.some((t) => t.id === p.theme) ? p.theme! : DEFAULTS.theme,
        opacity: clamp(Number(p.opacity) || DEFAULTS.opacity, 0.3, 1),
      };
    }
  } catch { /* localStorage may be unavailable / corrupt */ }
  try {
    const v = parseInt(localStorage.getItem("brandon.overlayFontSize") || "", 10);
    if (Number.isFinite(v)) return { ...DEFAULTS, fontSize: clamp(v, 12, 32) };
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

/** CSS custom properties to spread onto the overlay card's style. */
export function prefsToCssVars(p: OverlayPrefs): Record<string, string> {
  const light = p.theme === "light";
  // Background RGB the opacity is applied to, and matching text/chrome colors.
  const bg = light ? "255, 255, 255" : "26, 26, 30";
  const text = light ? "17, 17, 19" : "245, 245, 247";
  const textDim = light ? "90, 90, 96" : "180, 180, 188";
  const line = light ? "0, 0, 0" : "255, 255, 255";   // border base (low alpha applied in CSS)
  // Scale blur with opacity so the slider is actually visible.
  const blur = Math.round(p.opacity * 18);
  return {
    "--bubble-font-size": `${p.fontSize}px`,
    "--ov-bg": bg,
    "--ov-opacity": String(p.opacity),
    "--ov-blur": `${blur}px`,
    "--ov-text": text,
    "--ov-text-dim": textDim,
    "--ov-line": line,
  };
}

export function useOverlayPrefs() {
  const [prefs, setPrefs] = useState<OverlayPrefs>(load);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }, [prefs]);
  const update = useCallback((patch: Partial<OverlayPrefs>) => setPrefs((p) => ({ ...p, ...patch })), []);
  const reset = useCallback(() => setPrefs({ ...DEFAULTS }), []);
  return { prefs, update, reset };
}
