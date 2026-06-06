// Brandon's brand mark — matches the app/tray icon: a blue rounded-square badge
// holding a white speech bubble (assistant) with a four-point spark inside
// (insight/answer) plus a small accent spark. Flat fills so it stays crisp from
// a 22px sidebar chip to a 64px hero. No letter.
export function BrandonMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      className={className}
      aria-label="Brandon"
      role="img"
    >
      <rect x="0" y="0" width="512" height="512" rx="116" fill="#1E7EF0" />
      {/* Speech bubble with tail */}
      <path
        d="M150 122 h212 a46 46 0 0 1 46 46 v152 a46 46 0 0 1 -46 46 h-86 l-60 56 v-56 h-66 a46 46 0 0 1 -46 -46 v-152 a46 46 0 0 1 46 -46 z"
        fill="#FFFFFF"
      />
      {/* Big four-point spark */}
      <path
        d="M252 170 c 11 48 23 60 71 71 c -48 11 -60 23 -71 71 c -11 -48 -23 -60 -71 -71 c 48 -11 60 -23 71 -71 z"
        fill="#1E7EF0"
      />
      {/* Small accent spark */}
      <path
        d="M338 156 c 4.5 17 8.5 21 25.5 25.5 c -17 4.5 -21 8.5 -25.5 25.5 c -4.5 -17 -8.5 -21 -25.5 -25.5 c 17 -4.5 21 -8.5 25.5 -25.5 z"
        fill="#3D9BFF"
      />
    </svg>
  );
}
