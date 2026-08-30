import type { ReactNode } from "react";

/**
 * Ceremonial card (DESIGN.md §8): fresh-parchment surface, double gold border,
 * tight radius (diplomas are not bubbly), soft fathom shadow. Padding is left
 * to the caller so letter/report/credential can set their own rhythm.
 */
export default function CeremonialFrame({
  children,
  className = "",
  as: Tag = "article",
}: {
  children: ReactNode;
  className?: string;
  as?: "article" | "section" | "div";
}) {
  return (
    <Tag
      className={`bg-parchment-bright border-[3px] border-double border-gold rounded-sm shadow-[0_10px_40px_rgba(20,48,62,0.12)] ${className}`}
    >
      {children}
    </Tag>
  );
}
