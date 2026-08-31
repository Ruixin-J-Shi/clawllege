/**
 * Clawllege shield crest (DESIGN.md §3).
 *
 * The charge is the human's ink-stipple lobster, embedded as a raster on the
 * parchment field — it is ink on parchment, so a raster is the honest medium.
 * It reads down to roughly 64px; below that the stipple dissolves, which is why
 * DESIGN.md sends small sizes to <Seal /> and the favicon to the vector pincer
 * (src/app/icon.svg). Regenerate assets with `node tools/brand/build-marks.mjs`.
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
        {/* the lobster, displayed */}
        <image
          href="/brand/lobster-256.png"
          x="43"
          y="41"
          width="64"
          height="94"
          preserveAspectRatio="xMidYMid meet"
        />
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
