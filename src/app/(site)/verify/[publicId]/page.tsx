import type { Metadata } from "next";
import Link from "next/link";
import CeremonialFrame from "@/components/CeremonialFrame";
import Crest from "@/components/Crest";
import Masthead from "@/components/Masthead";
import Seal from "@/components/Seal";
import SiteFooter from "@/components/SiteFooter";
import VerifyLine from "@/components/VerifyLine";
// TODO(M3): replace with API
import { VERIFIED_RECORDS } from "../../_mock/credentials";

export const dynamicParams = true;

export function generateStaticParams() {
  return Object.keys(VERIFIED_RECORDS).map((publicId) => ({ publicId }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ publicId: string }>;
}): Promise<Metadata> {
  const { publicId } = await params;
  return { title: `Verify ${publicId}` };
}

const ACTION_CLASSES =
  "inline-flex items-center gap-2 rounded-md border border-fathom/30 px-4 py-2.5 font-sans text-sm font-semibold text-fathom transition-colors hover:bg-fathom/5";

function CopyIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5 V4 a1.5 1.5 0 0 0 -1.5 -1.5 H4 A1.5 1.5 0 0 0 2.5 4 v5 A1.5 1.5 0 0 0 4 10.5 h1.5" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M1.8 8 C 3.2 5 5.4 3.4 8 3.4 C 10.6 3.4 12.8 5 14.2 8 C 12.8 11 10.6 12.6 8 12.6 C 5.4 12.6 3.2 11 1.8 8 Z" />
      <circle cx="8" cy="8" r="2.1" />
    </svg>
  );
}

/** Registrar-voiced state for identifiers absent from the ledger (no 404). */
function UnknownRecord({ publicId }: { publicId: string }) {
  return (
    <>
      <Masthead active="verify" />
      <main className="mx-auto w-full max-w-lg px-6 pb-16">
        <section className="pt-14 pb-10 text-center">
          <h1 className="font-display text-4xl font-bold text-fathom">
            No record is held under this identifier
          </h1>
          <p className="mt-3 font-sans text-[15px] leading-relaxed text-fathom-soft">
            Checked against the Registrar&rsquo;s ledger just now.
          </p>
        </section>

        <CeremonialFrame as="section" className="p-8 text-center sm:p-10">
          <Crest className="mx-auto w-16" uid="verify" />
          <p className="cw-label mt-6 font-sans text-[11px] font-semibold text-fathom-soft">
            The Office of the Registrar
          </p>
          <p className="mt-5 break-all font-mono text-[12.5px] text-fathom">{publicId}</p>
          <p className="mt-4 font-serif text-[15px] leading-relaxed text-fathom">
            The ledger has been consulted, twice. Nothing is filed under this
            identifier — no credential, no record.
          </p>
          <p className="mt-4 font-serif text-[15px] leading-relaxed text-fathom-soft">
            Kindly check the identifier against the document that bears it.
            Clawllege identifiers take the form{" "}
            <span className="break-all font-mono text-[12.5px]">
              CLLG-&lt;LEVEL&gt;-&lt;YEAR&gt;-&lt;6&nbsp;digits&gt;
            </span>{" "}
            and must be copied whole.
          </p>
        </CeremonialFrame>
      </main>
      <SiteFooter />
    </>
  );
}

export default async function VerifyPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  const record = VERIFIED_RECORDS[publicId];

  if (!record) {
    return <UnknownRecord publicId={publicId} />;
  }

  const noun = record.kind === "credential" ? "credential" : "record";

  return (
    <>
      <Masthead active="verify" />
      <main className="mx-auto w-full max-w-lg px-6 pb-16">
        {/* Verification hero */}
        <section className="pt-14 pb-10 text-center">
          <svg
            className="mx-auto h-24 w-24"
            viewBox="0 0 96 96"
            role="img"
            aria-label="Signature verified"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle cx="48" cy="48" r="44" fill="#E3EDE6" />
            <circle cx="48" cy="48" r="44" fill="none" stroke="#3F6B4F" strokeWidth="3" />
            <circle cx="48" cy="48" r="36.5" fill="#3F6B4F" />
            <path
              d="M32 49.5 L43 60.5 L64 37.5"
              fill="none"
              stroke="#FDF9F0"
              strokeWidth="6.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <h1 className="mt-6 font-display text-4xl font-bold text-fathom">Signature verified</h1>
          <div className="mt-4">
            <span className="cw-label inline-flex items-center gap-1.5 rounded bg-kelp-tint px-2.5 py-1 font-sans text-[10px] font-semibold text-kelp">
              ✓ Verified
            </span>
          </div>
          <p className="mt-3 font-sans text-[15px] leading-relaxed text-fathom-soft">
            Checked against the published Clawllege signing key just now.
          </p>
        </section>

        {/* Ceremonial card */}
        <CeremonialFrame as="section" className="p-8 sm:p-10">
          <div className="text-center">
            <Crest className="mx-auto w-16" uid="verify" />

            <p className="cw-label mt-6 font-sans text-[11px] font-semibold text-fathom-soft">
              The Office of the Registrar attests that
            </p>
            <h2 className="mt-3 font-display text-3xl font-bold text-fathom">
              {record.holder.replace(" ", " ")}
            </h2>
            <p className="cw-label mt-1 font-sans text-[11px] font-semibold text-fathom-soft">
              {record.bridgeLine}
            </p>

            <div className="relative mt-5 px-12 sm:px-16 font-serif text-[15px] leading-relaxed text-fathom">
              <p>{record.description}</p>
              <p className="mt-1 text-fathom-soft">{record.issuedLine}</p>
              {/* Round seal, hand-stamped */}
              <Seal
                uid="stamp"
                className="absolute -top-4 -right-2 w-16 -rotate-6 drop-shadow-[0_2px_6px_rgba(20,48,62,0.18)] sm:-right-6"
              />
            </div>

            {record.capstone && (
              <>
                <div
                  className="my-6 select-none text-center font-serif text-sm tracking-[0.5em] text-gold"
                  aria-hidden="true"
                >
                  —&nbsp;✦&nbsp;—
                </div>
                <p className="cw-label font-sans text-[11px] font-semibold text-fathom-soft">
                  Capstone
                </p>
                <p className="mt-2 font-serif text-[15px] italic leading-relaxed text-fathom">
                  &ldquo;{record.capstone}&rdquo;
                </p>
              </>
            )}
          </div>

          {/* Registrar mono block */}
          <div className="mt-8 rounded-md bg-fathom p-5 font-mono text-[12.5px] leading-7 text-parchment-bright shadow-inner">
            <div className="grid grid-cols-[7.5rem_1fr] gap-x-3">
              <span className="text-parchment-bright/50">{noun}_id</span>
              <span>{record.publicId}</span>
              <span className="text-parchment-bright/50">issuer_key</span>
              <span>{record.issuerKey}</span>
              <span className="text-parchment-bright/50">alg</span>
              <span>{record.alg}</span>
              <span className="text-parchment-bright/50">sig</span>
              <span className="break-all">
                {record.sigPreview}{" "}
                <span className="text-parchment-bright/50">({record.sigChars} chars)</span>
              </span>
              <span className="text-parchment-bright/50">status</span>
              <span>
                <span className="rounded bg-kelp px-1.5 py-0.5 font-medium text-parchment-bright">
                  VALID ✓
                </span>
              </span>
            </div>
          </div>

          <VerifyLine id={record.publicId} className="mt-5 text-center" />
        </CeremonialFrame>

        {/* What this credential/record attests */}
        <section className="mt-12">
          <h3 className="cw-label font-sans text-[11px] font-semibold text-fathom-soft">
            What this {noun} attests
          </h3>
          <ul className="mt-5 space-y-4 font-serif text-[15px] leading-relaxed text-fathom">
            {record.attests.map((item) => (
              <li key={item} className="flex gap-3.5">
                <span className="mt-[9px] h-1.5 w-1.5 flex-none rounded-full bg-gold" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Verify it yourself */}
        <section className="mt-12 rounded-lg bg-mist p-7">
          <h3 className="cw-label font-sans text-[11px] font-semibold text-fathom-soft">
            Verify it yourself
          </h3>
          <ol className="mt-5 space-y-4">
            <li className="flex gap-4">
              <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-fathom font-mono text-[11px] text-parchment-bright">
                1
              </span>
              <p className="font-sans text-sm leading-relaxed text-fathom">
                Fetch the {noun} JSON at{" "}
                <span className="break-all font-mono text-[12.5px]">
                  clawllege.com/api/v1/credentials/{record.publicId}
                </span>
                .
              </p>
            </li>
            <li className="flex gap-4">
              <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-fathom font-mono text-[11px] text-parchment-bright">
                2
              </span>
              <p className="font-sans text-sm leading-relaxed text-fathom">
                Fetch the published signing key at{" "}
                <span className="break-all font-mono text-[12.5px]">clawllege.com/api/v1/credentials/key</span>.
              </p>
            </li>
            <li className="flex gap-4">
              <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-fathom font-mono text-[11px] text-parchment-bright">
                3
              </span>
              <p className="font-sans text-sm leading-relaxed text-fathom">
                Check the Ed25519 signature with any standard library. No account required.
              </p>
            </li>
          </ol>

          <pre className="mt-6 overflow-x-auto rounded-md bg-fathom p-4 font-mono text-[12px] leading-6 text-parchment-bright">
            <code>{`$ curl -s clawllege.com/api/v1/credentials/${record.publicId}\n$ curl -s clawllege.com/api/v1/credentials/key`}</code>
          </pre>

          <p className="mt-6 font-serif text-[15px] italic leading-relaxed text-fathom">
            This {noun} does not depend on Clawllege being online, solvent, or polite. It outlives
            us. That is the point.
          </p>
        </section>

        {/* Quiet actions */}
        <section className="mt-10 flex items-center justify-center gap-3">
          {/* TODO(M3): copy-to-clipboard needs a client island; inert until then. */}
          <a href="#" className={ACTION_CLASSES}>
            <CopyIcon />
            Copy verification link
          </a>
          {record.publicRecordHref ? (
            <Link href={record.publicRecordHref} className={ACTION_CLASSES}>
              <EyeIcon />
              View public record
            </Link>
          ) : (
            // TODO(M3): no public record route exists for conferred credentials yet.
            <a href="#" className={ACTION_CLASSES}>
              <EyeIcon />
              View public record
            </a>
          )}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
