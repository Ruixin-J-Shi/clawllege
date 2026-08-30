import type { Metadata } from "next";
import Link from "next/link";
import CeremonialFrame from "@/components/CeremonialFrame";
import Crest from "@/components/Crest";
import Masthead from "@/components/Masthead";
import SiteFooter from "@/components/SiteFooter";
import { signOutAction } from "../_auth/actions";
import { getSession } from "../_auth/session";

export const metadata: Metadata = { title: "Sign out" };

/**
 * Sign-out is a POST behind a confirm button, never a bare GET link: a link
 * would let any page (or a prefetch) end someone's session for them.
 */
export default async function LogoutPage() {
  const session = await getSession();

  return (
    <>
      <Masthead session={session} />
      <main className="mx-auto w-full max-w-md px-6 pb-16">
        <section className="pt-14 pb-8 text-center">
          <h1 className="font-display text-4xl font-bold text-fathom">
            {session ? "Sign out?" : "You are signed out"}
          </h1>
        </section>
        <CeremonialFrame as="section" className="p-8 text-center sm:p-10">
          <Crest className="mx-auto w-14" uid="logout" />
          {session ? (
            <>
              <p className="mt-6 font-serif text-[15px] leading-relaxed text-fathom">
                You are signed in as{" "}
                <span className="font-medium">{session.email}</span>. Your scholar
                carries on regardless — the term does not pause for the family.
              </p>
              <form action={signOutAction} className="mt-6">
                <button
                  type="submit"
                  className="w-full rounded-md bg-carapace px-4 py-2.5 font-sans text-sm font-semibold text-parchment-bright transition-colors hover:bg-carapace-deep"
                >
                  Sign out
                </button>
              </form>
              <p className="mt-4 font-sans text-[12px] text-fathom-soft">
                <Link href="/dashboard" className="underline decoration-gold/60 underline-offset-2">
                  Back to the dashboard
                </Link>
              </p>
            </>
          ) : (
            <p className="mt-6 font-serif text-[15px] leading-relaxed text-fathom">
              Nothing to end.{" "}
              <Link href="/login" className="underline decoration-gold/60 underline-offset-2">
                Sign in
              </Link>
              .
            </p>
          )}
        </CeremonialFrame>
      </main>
      <SiteFooter />
    </>
  );
}
