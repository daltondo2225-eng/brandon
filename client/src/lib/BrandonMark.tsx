// Brandon's brand mark — a rounded-square badge with a stylized "B" formed from
// two stacked lobes and a vertical stem, over a blue gradient. Scales cleanly
// from a 22px sidebar chip to a 72px hero. `size` is the pixel box; the gradient
// id is salted by size so multiple instances on one page don't collide.
export function BrandonMark({ size = 32, className }: { size?: number; className?: string }) {
  const gid = `brandon-grad-${size}`;
  const sid = `brandon-spark-${size}`;
  const r = size * 0.28; // corner radius, ChatGPT-ish squircle
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      aria-label="Brandon"
      role="img"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3B9BFF" />
          <stop offset="0.55" stopColor="#1E7EF0" />
          <stop offset="1" stopColor="#1257C9" />
        </linearGradient>
        <linearGradient id={sid} x1="20" y1="14" x2="44" y2="50" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#E4F0FF" />
        </linearGradient>
      </defs>
      {/* Badge */}
      <rect x="0" y="0" width="64" height="64" rx={(r / size) * 64} fill={`url(#${gid})`} />
      {/* Stylized "B": stem + two lobes */}
      <path
        d="M23 16h12.5c5.8 0 9.7 3.1 9.7 8.1 0 3.2-1.8 5.6-4.7 6.7 3.6.9 5.9 3.6 5.9 7.4 0 5.4-4.2 8.8-10.6 8.8H23V16Zm6.6 5.4v6.7h5.1c2.6 0 4.2-1.3 4.2-3.4 0-2.1-1.6-3.3-4.2-3.3h-5.1Zm0 11.7v7.3h5.7c2.8 0 4.5-1.4 4.5-3.7 0-2.3-1.7-3.6-4.6-3.6h-5.6Z"
        fill={`url(#${sid})`}
      />
      {/* Spark accent — signals "AI/live" */}
      <path
        d="M48 12.5l1.3 3.2 3.2 1.3-3.2 1.3L48 22.5l-1.3-3.2-3.2-1.3 3.2-1.3L48 12.5Z"
        fill="#FFFFFF"
        opacity="0.95"
      />
    </svg>
  );
}
