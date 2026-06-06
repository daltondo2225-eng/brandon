// Overlay appearance preferences — persisted to localStorage, tuned live from
// the in-overlay gear popover. Curated presets keep it readable + discreet.
import { useCallback, useEffect, useState } from "react";

// "light" intentionally omitted for now: the overlay's text/chrome colors are
// tuned for a dark glass; a light theme needs a full text-color sweep first.
export type OverlayTheme = "dark" | "black";
export type OverlayFont = "sans" | "serif" | "mono";

export interface OverlayPrefs {
  fontSize: number;     // px, 12–32
  font: OverlayFont;
  theme: OverlayTheme;
  accent: string;       // hex, from ACCENTS
  opacity: number;      // 0.30–1.00 — the overlay card/background alpha ("capacity")
}

export const FONTS: { id: OverlayFont; label: string; stack: string }[] = [
  { id: "sans", label: "Sans", stack: '"Inter", -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: "serif", label: "Serif", stack: 'Georgia, "Times New Roman", serif' },
  { id: "mono", label: "Mono", stack: '"SF Mono", "Cascadia Code", "Consolas", monospace' },
];

export const THEMES: { id: OverlayTheme; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "black", label: "Black" },
];

export const ACCENTS = ["#1E7EF0", "#22C55E", "#A855F7", "#F59E0B", "#EC4899"];

const DEFAULTS: OverlayPrefs = {
  fontSize: 18,
  font: "sans",
  theme: "dark",
  accent: ACCENTS[0],
  opacity: 0.82,
};

const KEY = "brandon.overlayPrefs";

function load(): OverlayPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<OverlayPrefs>;
      return {
        fontSize: clamp(Number(p.fontSize) || DEFAULTS.fontSize, 12, 32),
        font: FONTS.some((f) => f.id === p.font) ? p.font! : DEFAULTS.font,
        theme: THEMES.some((t) => t.id === p.theme) ? p.theme! : DEFAULTS.theme,
        accent: typeof p.accent === "string" ? p.accent : DEFAULTS.accent,
        opacity: clamp(Number(p.opacity) || DEFAULTS.opacity, 0.3, 1),
      };
    }
  } catch { /* localStorage may be unavailable / corrupt */ }
  // Migrate the old standalone font-size key if present.
  try {
    const v = parseInt(localStorage.getItem("brandon.overlayFontSize") || "", 10);
    if (Number.isFinite(v)) return { ...DEFAULTS, fontSize: clamp(v, 12, 32) };
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Theme → background RGB the opacity is applied to. */
function themeBgRgb(theme: OverlayTheme): string {
  return theme === "black" ? "8, 8, 10" : "26, 26, 30";
}

/** CSS custom properties to spread onto the overlay card's style. */
export function prefsToCssVars(p: OverlayPrefs): Record<string, string> {
  const fontStack = FONTS.find((f) => f.id === p.font)?.stack ?? FONTS[0].stack;
  const bg = themeBgRgb(p.theme);
  const text = "245, 245, 247";
  return {
    "--bubble-font-size": `${p.fontSize}px`,
    "--ov-font": fontStack,
    "--ov-accent": p.accent,
    "--ov-bg": bg,
    "--ov-opacity": String(p.opacity),
    "--ov-text": text,
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
