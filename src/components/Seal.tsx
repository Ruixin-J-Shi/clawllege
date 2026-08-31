/**
 * Round seal of Clawllege (DESIGN.md §3). Use for stamps, wax-seal moments, and
 * small sizes. Rotate -6deg (e.g. className="-rotate-6") when it plays a
 * "stamped by hand" role; never rotate the shield crest.
 *
 * The charge is the same lobster as the crest, repainted Drawn-Butter Gold: in
 * Fathom Ink on Carapace Crimson it was all but invisible, and the seal read as
 * empty. Regenerate with `node tools/brand/build-marks.mjs`.
 *
 * Pass a distinct `uid` when rendering more than one seal on a page.
 */
export default function Seal({
  className = "w-16",
  uid = "cw",
}: {
  className?: string;
  uid?: string;
}) {
  const arcId = `${uid}SealArc`;
  return (
    <svg
      className={className}
      viewBox="0 0 120 120"
      role="img"
      aria-label="Seal of Clawllege"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="60" cy="60" r="57" fill="#9E2B25" />
      <circle cx="60" cy="60" r="51" fill="none" stroke="#C9A227" strokeWidth="1.5" />
      <circle cx="60" cy="60" r="34" fill="none" stroke="#C9A227" strokeWidth="1" />
      <defs>
        <path
          id={arcId}
          d="M60 60 m -42.5 0 a 42.5 42.5 0 1 1 85 0 a 42.5 42.5 0 1 1 -85 0"
        />
      </defs>
      <text
        fontSize="8"
        letterSpacing="1.6"
        fill="#F6EFE3"
        fontFamily="Georgia, 'Times New Roman', serif"
      >
        <textPath href={`#${arcId}`}>SIGILLUM · CLAWLLEGII · EST · MMXXVI · </textPath>
      </text>
      <image
        href="/brand/lobster-gold-128.png"
        x="38"
        y="26"
        width="44"
        height="66"
        preserveAspectRatio="xMidYMid meet"
      />
      {/* four bezants — one per rung of the ladder */}
      <g fill="#C9A227">
        <circle cx="42" cy="90" r="2.6" />
        <circle cx="54" cy="92" r="2.6" />
        <circle cx="66" cy="92" r="2.6" />
        <circle cx="78" cy="90" r="2.6" />
      </g>
    </svg>
  );
}
