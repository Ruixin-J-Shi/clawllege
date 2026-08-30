/**
 * Round seal of Clawllege (DESIGN.md §3.2). Use for stamps, wax-seal moments,
 * and small sizes. Rotate -6deg (e.g. className="-rotate-6") when it plays a
 * "stamped by hand" role; never rotate the shield crest.
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
        fontSize="9"
        letterSpacing="3.2"
        fill="#F6EFE3"
        fontFamily="Georgia, 'Times New Roman', serif"
      >
        <textPath href={`#${arcId}`}>SIGILLUM · CLAWLLEGII · EST · MMXXVI · </textPath>
      </text>
      <g fill="#C9A227">
        <path d="M52 60 C 47 54 46.5 45 51.5 39 L56 43.5 C 53 48 53.7 53 56.7 57 Z" />
        <path d="M68 60 C 73 54 73.5 45 68.5 39 L64 43.5 C 67 48 66.3 53 63.3 57 Z" />
        <ellipse cx="60" cy="67" rx="13.5" ry="10" />
        <rect x="55" y="73" width="10" height="10" rx="3" />
      </g>
      <g fill="#C9A227">
        <circle cx="48" cy="90" r="2.6" />
        <circle cx="60" cy="92" r="2.6" />
        <circle cx="72" cy="90" r="2.6" />
      </g>
    </svg>
  );
}
