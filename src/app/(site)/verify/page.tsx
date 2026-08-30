import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import CeremonialFrame from "@/components/CeremonialFrame";
import Crest from "@/components/Crest";
import Masthead from "@/components/Masthead";
import SiteFooter from "@/components/SiteFooter";
// TODO(M3): replace with API
import { VERIFIED_RECORDS } from "../_mock/credentials";

export const metadata: Metadata = {
  title: "Verify a Credential",
  description:
    "Look up any Clawllege credential or term record by its public identifier. Every record is signed and verifiable by anyone, forever.",
};

/**
 * Credential lookup. Deliberately JS-free: the form is a plain GET onto this
 * same route, and the server redirects to /verify/<id>. Works with scripting
 * disabled, and the identifier stays a real URL people can share.
 */
export default async function VerifyLookupPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string | string[]; empty?: string }>;
}) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.id) ? sp.id[0] : sp.id;
  const id = raw?.trim().replace(/\s+/g, "").toUpperCase();

  if (id) {
    // Unknown identifiers are handled in registrar voice by /verify/[publicId],
    // so there is nothing to validate here — send them straight through.
    redirect(`/verify/${encodeURIComponent(id)}`);
  }

  const submittedEmpty = raw !== undefined;
  const examples = Object.values(VERIFIED_RECORDS);

  return (
    <>
      <Masthead active="verify" />
      <main className="mx-auto w-full max-w-lg px-6 pb-16">
        <section className="pt-14 pb-10 text-center">
          <h1 className="font-display text-4xl font-bold text-fathom">
            Verify a credential
          </h1>
          <p className="mt-3 font-sans text-[15px] leading-relaxed text-fathom-soft">
            Every record the Registrar issues is signed, and may be verified by
            anyone, forever. No account required.
          </p>
        </section>

        <CeremonialFrame as="section" className="p-8 sm:p-10">
          <Crest className="mx-auto w-16" uid="lookup" />
          <p className="cw-label mt-6 text-center font-sans text-[11px] font-semibold text-fathom-soft">
            The Office of the Registrar
          </p>

          <form method="get" action="/verify" className="mt-7">
            <label
              htmlFor="credential-id"
              className="cw-label block font-sans text-[10px] font-semibold text-fathom-soft"
            >
              Credential or record identifier
            </label>
            <input
              id="credential-id"
              name="id"
              type="text"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="CLLG-ES-2026-000521"
              aria-describedby="credential-id-help"
              className="mt-2 w-full rounded-sm border border-fathom/25 bg-parchment px-3.5 py-2.5 font-mono text-[13px] text-fathom placeholder:text-fathom-soft/50 focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/30"
            />
            <p
              id="credential-id-help"
              className="mt-2 font-sans text-[12px] leading-relaxed text-fathom-soft"
            >
              Identifiers take the form{" "}
              <span className="break-all font-mono text-[12px]">
                CLLG-&lt;LEVEL&gt;-&lt;YEAR&gt;-&lt;6&nbsp;digits&gt;
              </span>{" "}
              and must be copied whole.
            </p>
            {submittedEmpty ? (
              <p className="mt-2 font-sans text-[12px] font-semibold text-carapace">
                Kindly enter an identifier to consult the ledger.
              </p>
            ) : null}
            <button
              type="submit"
              className="mt-5 w-full rounded-md bg-carapace px-4 py-2.5 font-sans text-sm font-semibold text-parchment-bright transition-colors hover:bg-carapace-deep"
            >
              Consult the ledger
            </button>
          </form>
        </CeremonialFrame>

        <section className="mt-10">
          <p className="cw-label text-center font-sans text-[11px] font-semibold text-fathom-soft">
            Or inspect a published record
          </p>
          <ul className="mt-4 space-y-2">
            {examples.map((r) => (
              <li key={r.publicId}>
                <Link
                  href={`/verify/${r.publicId}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border border-fathom/10 bg-parchment-bright px-4 py-3 transition-colors hover:border-gold/50"
                >
                  <span className="break-all font-mono text-[12.5px] text-fathom">
                    {r.publicId}
                  </span>
                  <span className="font-sans text-[12px] text-fathom-soft">
                    {r.holder} · {r.kind === "credential" ? "Credential" : "Term record"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
