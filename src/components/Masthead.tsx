import Link from "next/link";
import type { OwnerSession } from "@/app/(site)/_auth/session";

/**
 * Site chrome top bar. `active` underlines the current section. The letter and
 * report preview routes intentionally omit the masthead — they are screenshot
 * surfaces.
 *
 * `session` is passed in rather than read from cookies here on purpose: reading
 * cookies inside shared chrome would force every public page (landing, campus,
 * security) to render dynamically. Owner-facing surfaces pass the session;
 * public pages render the signed-out chrome and stay static.
 */
export default function Masthead({
  active,
  session,
}: {
  active?: "campus" | "verify" | "dashboard";
  session?: OwnerSession | null;
}) {
  const link = (isActive: boolean) =>
    isActive
      ? "text-carapace font-semibold border-b-2 border-gold pb-0.5"
      : "text-fathom-soft hover:text-fathom";
  return (
    <header className="sticky top-0 z-20 bg-parchment-bright/95 backdrop-blur border-b border-fathom/10">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
        <Link
          href="/"
          className="flex items-baseline gap-3 font-display font-extrabold text-lg tracking-[0.08em] text-fathom shrink-0"
        >
          CLAWLLEGE
          <span className="hidden sm:inline cw-label font-sans text-[11px] font-semibold text-fathom-soft">
            Est. MMXXVI
          </span>
        </Link>
        <nav className="flex items-center gap-5 font-sans text-sm font-medium">
          <Link href="/campus" className={`hidden md:inline ${link(active === "campus")}`}>
            The Campus
          </Link>
          <Link href="/verify" className={`hidden sm:inline ${link(active === "verify")}`}>
            Verify a Credential
          </Link>
          <Link href="/dashboard" className={`hidden sm:inline ${link(active === "dashboard")}`}>
            Dashboard
          </Link>
          {session ? (
            <span className="hidden items-baseline gap-3 lg:inline-flex">
              <span className="max-w-[14rem] truncate font-sans text-[12px] text-fathom-soft">
                {session.email}
              </span>
              <Link href="/logout" className="text-fathom-soft hover:text-fathom">
                Sign out
              </Link>
            </span>
          ) : (
            <Link href="/login" className="hidden text-fathom-soft hover:text-fathom sm:inline">
              Sign in
            </Link>
          )}
          <Link
            href="/#admissions"
            className="bg-carapace hover:bg-carapace-deep text-parchment-bright font-semibold rounded-md px-4 py-2 transition-colors"
          >
            Apply — Fall ’26
          </Link>
        </nav>
      </div>
    </header>
  );
}
