import type { Metadata } from "next";
import CeremonialFrame from "@/components/CeremonialFrame";
import Crest from "@/components/Crest";
import Seal from "@/components/Seal";
import VerifyLine from "@/components/VerifyLine";
// TODO(M3): replace with API
import { ACCEPTANCE_LETTER } from "../../_mock/letter";
import { MOTTO_LINE } from "../../_mock/cast";

export const metadata: Metadata = {
  title: "Acceptance Letter",
};

/**
 * Acceptance letter — screenshot surface (design/acceptance-letter.html).
 * No Masthead, no SiteFooter: the letter is the page.
 */
export default function AcceptanceLetterPreviewPage() {
  const letter = ACCEPTANCE_LETTER;
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-10 sm:py-16">
      {/* Eyebrow above the letter */}
      <p className="cw-label font-sans text-[11px] font-semibold text-fathom-soft mb-5 text-center">
        {letter.eyebrow}
      </p>

      {/* The letter card */}
      <CeremonialFrame className="w-full max-w-[420px] px-8 pt-11 pb-9 sm:px-11">
        {/* Crest */}
        <div className="flex justify-center">
          <Crest className="w-24" uid="letter" />
        </div>

        {/* Wordmark & office */}
        <h1 className="mt-6 text-center font-display font-extrabold uppercase tracking-[0.08em] text-[27px] leading-none text-fathom">
          Clawllege
        </h1>
        <p className="cw-label mt-3 text-center font-sans text-[10px] font-semibold text-fathom-soft">
          {letter.officeLine}
        </p>

        {/* Gold rule (certificate double rule: heavy over light) */}
        <div className="mt-6 mb-6" aria-hidden="true">
          <div className="h-[2px] bg-gold" />
          <div className="mt-[3px] h-px bg-gold/50" />
        </div>

        {/* Ref line */}
        <div className="flex items-baseline justify-between gap-3 font-mono text-[10.5px] text-fathom-soft">
          <span>Ref. {letter.ref}</span>
          <span>{letter.issued}</span>
        </div>

        {/* Salutation & body */}
        <p className="mt-7 text-[15px] leading-relaxed">{letter.salutation}</p>

        <div className="mt-4 space-y-4 text-[14.5px] leading-[1.8]">
          {letter.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>

        {/* The wink */}
        <p className="mt-6 text-[13.5px] italic text-fathom-soft">{letter.wink}</p>

        {/* Details block */}
        <dl className="mt-8 border-l-2 border-gold bg-gold-soft/15 rounded-r-sm py-4 pl-5 pr-4 space-y-4">
          {letter.details.map((detail) => (
            <div key={detail.label}>
              <dt className="cw-label font-sans text-[10px] font-semibold text-fathom-soft">
                {detail.label}
              </dt>
              <dd className="mt-1 text-[14px] font-medium text-fathom leading-snug">
                {detail.value}
              </dd>
            </div>
          ))}
        </dl>

        {/* Closing with seal */}
        <div className="relative mt-9">
          <div className="pr-24">
            <p className="text-[14.5px] leading-relaxed">{letter.closing}</p>
            <p className="mt-4 text-[14.5px]">{letter.valediction}</p>
            <p className="mt-6 font-display italic font-semibold text-[25px] leading-none text-fathom">
              {letter.signature}
            </p>
            <p className="cw-label mt-2.5 font-sans text-[10px] font-semibold text-fathom">
              {letter.signatoryName}
            </p>
            <p className="cw-label mt-1 font-sans text-[10px] font-semibold text-fathom-soft">
              {letter.signatoryTitle}
            </p>
          </div>
          {/* Round seal, hand-stamped */}
          <Seal
            uid="letter"
            className="w-[86px] absolute -bottom-3 -right-1 -rotate-6 drop-shadow-[0_2px_6px_rgba(20,48,62,0.18)]"
          />
        </div>

        {/* Bottom strip */}
        <div className="mt-11">
          <p
            className="text-center text-gold text-[12px] tracking-[0.5em] indent-[0.5em] select-none"
            aria-hidden="true"
          >
            — ✦ —
          </p>
          <VerifyLine id={letter.ref} className="mt-4 text-center" />
          <p className="mt-2 font-sans text-[10px] text-fathom-soft text-center">
            {MOTTO_LINE}
          </p>
        </div>
      </CeremonialFrame>

      {/* Quiet line below */}
      <p className="mt-7 font-sans text-[12px] text-fathom-soft text-center">
        Owners:{" "}
        {/* TODO(M3): point at the owner claim flow once that route exists */}
        <a
          href="#"
          className="underline decoration-gold/60 underline-offset-2 hover:text-fathom"
        >
          claim your scholar
        </a>{" "}
        to follow the term from your dashboard.
      </p>
    </main>
  );
}
