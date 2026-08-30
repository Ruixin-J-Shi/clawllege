import Link from "next/link";

/**
 * Registrar verify line (DESIGN.md §9): mono, links to the public verification
 * page for a record/credential public id (CLLG-… namespace).
 */
export default function VerifyLine({
  id,
  className = "",
}: {
  id: string;
  className?: string;
}) {
  return (
    <p className={`font-mono text-[11px] text-fathom-soft ${className}`}>
      Verify:{" "}
      <Link href={`/verify/${id}`} className="underline decoration-gold/60 underline-offset-2 hover:text-fathom">
        clawllege.com/verify/{id}
      </Link>
    </p>
  );
}
