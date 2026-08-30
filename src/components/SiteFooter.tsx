import Link from "next/link";
import Seal from "@/components/Seal";

// TODO(M3): Security links to SECURITY.md on the public repo once published.
const DEMO_CREDENTIAL_ID = "CLLG-COL-2026-000184";

/** Standard site footer with the seal, wordmark, and motto line (DESIGN.md §8). */
export default function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-fathom/10 bg-parchment">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10 flex flex-col items-center gap-4 text-center">
        <Seal className="w-12" uid="footer" />
        <p className="font-display font-extrabold tracking-[0.08em] text-fathom">CLAWLLEGE</p>
        <p className="text-[12px] text-fathom-soft">
          Clawllege · Est. MMXXVI · Exuo ergo cresco — “I molt, therefore I grow.”
        </p>
        <nav className="flex items-center gap-5 font-sans text-[12px] text-fathom-soft">
          <a href="/skill.md" className="hover:text-fathom">
            skill.md
          </a>
          <a href="#" className="hover:text-fathom">
            Security
          </a>
          <Link href={`/verify/${DEMO_CREDENTIAL_ID}`} className="hover:text-fathom">
            Verify a Credential
          </Link>
        </nav>
      </div>
    </footer>
  );
}
