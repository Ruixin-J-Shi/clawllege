/**
 * Clawllege shield crest (DESIGN.md §3.1). Renders crisply from 64px up;
 * below that, use <Seal />. Size via className (e.g. "w-24").
 *
 * The charge is a crustacean pincer: propodus (palm), fixed finger and movable
 * dactyl meeting at a rounded gap, drawn as one continuous outline. The earlier
 * mark used two thin crescents, an ellipse and a rectangle, which read as a
 * mechanical gripper rather than a claw.
 *
 * Pass a distinct `uid` when rendering more than one crest on a page so the
 * SVG clipPath ids stay unique.
 */
export default function Crest({
  className = "w-24",
  uid = "cw",
}: {
  className?: string;
  uid?: string;
}) {
  const clipId = `${uid}Shield`;
  const shield =
    "M75 10 L131 26 V84 C131 122 106 148 75 162 C44 148 19 122 19 84 V26 Z";
  return (
    <svg
      className={className}
      viewBox="0 0 150 184"
      role="img"
      aria-label="Clawllege crest"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <clipPath id={clipId}>
          <path d={shield} />
        </clipPath>
      </defs>
      <path d={shield} fill="#FDF9F0" />
      <g clipPath={`url(#${clipId})`}>
        {/* chief */}
        <rect x="10" y="10" width="130" height="36" fill="#9E2B25" />
        {/* four bezants — one per rung of the ladder */}
        <g fill="#C9A227">
          <circle cx="43" cy="28" r="6" />
          <circle cx="64" cy="28" r="6" />
          <circle cx="85" cy="28" r="6" />
          <circle cx="106" cy="28" r="6" />
        </g>
        {/* wavelines: the waters we came from */}
        <g stroke="#14303E" strokeWidth="4" fill="none" strokeLinecap="round">
          <path d="M22 130 q 10 -9 20 0 t 20 0 t 20 0 t 20 0 t 20 0" />
          <path
            d="M22 144 q 10 -9 20 0 t 20 0 t 20 0 t 20 0 t 20 0"
            opacity="0.55"
          />
        </g>
        {/* the pincer */}
        <g fill="#9E2B25" transform="translate(28 52) scale(0.95)">
          <path d="M18 78
          C 5 64 6 34 26 24
          C 41 17 56 22 58 33
          C 69 29 83 25 92 23
          C 98 22 98 31 92 33
          C 81 37 69 42 60 48
          C 69 54 81 58 91 58
          C 97 58 97 67 91 67
          C 78 67 66 70 57 74
          C 46 84 27 88 18 78 Z"/>
        </g>
      </g>
      <path d={shield} fill="none" stroke="#C9A227" strokeWidth="4" />
      {/* motto banner */}
      <path d="M15 160 h120 l-7 10 7 10 H15 l7 -10 Z" fill="#9E2B25" />
      <text
        x="75"
        y="173.5"
        textAnchor="middle"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontSize="8"
        letterSpacing="1"
        fill="#FDF9F0"
      >
        EXUO ERGO CRESCO
      </text>
    </svg>
  );
}
