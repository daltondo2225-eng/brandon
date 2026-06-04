// Brandon's avatar — an abstract "soundwave" glyph (five bars at varying
// heights, like a live audio meter) inside a rounded badge with a subtle
// gradient. Evokes "live listening assistant" rather than a letter. Scales
// cleanly from the 22px overlay pill to the larger sidebar mark.
//
// The same artwork is mirrored in src-tauri/icons/icon.svg for the app/tray
// icons — keep them in sync if you tweak the design.

interface Props {
  /** Rendered width/height in px (the badge is square). Default 22. */
  size?: number;
  className?: string;
  /** When true, draws only the bars with no badge background (for use on an
   *  already-colored chip). Default false. */
  bare?: boolean;
}

export function BrandMark({ size = 22, className, bare = false }: Props) {
  // Five bars, normalized heights (0–1) on a 24×24 viewBox.
  const bars = [0.42, 0.72, 1.0, 0.6, 0.34];
  const barW = 2.6;
  const gap = 1.7;
  const totalW = bars.length * barW + (bars.length - 1) * gap;
  const startX = (24 - totalW) / 2;
  const maxH = 13;
  const cy = 12;

  const gid = "brandon-grad";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-label="Brandon"
      role="img"
    >
      {!bare && (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#6ea8ff" />
              <stop offset="1" stopColor="#9b6bff" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="24" height="24" rx="7" fill={`url(#${gid})`} />
        </>
      )}
      {bars.map((h, i) => {
        const x = startX + i * (barW + gap);
        const barH = Math.max(barW, h * maxH);
        return (
          <rect
            key={i}
            x={x}
            y={cy - barH / 2}
            width={barW}
            height={barH}
            rx={barW / 2}
            fill={bare ? "currentColor" : "#fff"}
          />
        );
      })}
    </svg>
  );
}
