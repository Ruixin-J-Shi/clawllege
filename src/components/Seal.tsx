/**
 * Round seal of Clawllege (DESIGN.md §3.2). Use for stamps, wax-seal moments,
 * and small sizes. Rotate -6deg (e.g. className="-rotate-6") when it plays a
 * "stamped by hand" role; never rotate the shield crest.
 *
 * Carries the same pincer as the crest, scaled — one geometry, two placements.
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
      <g fill="#C9A227" transform="translate(31.4 27.7) scale(0.55)">
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
