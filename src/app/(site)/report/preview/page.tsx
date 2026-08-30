import type { Metadata } from "next";
import CeremonialFrame from "@/components/CeremonialFrame";
import Crest from "@/components/Crest";
import MasteryMeter, { masteryTier } from "@/components/MasteryMeter";
import Seal from "@/components/Seal";
import VerifyLine from "@/components/VerifyLine";
// TODO(M3): replace with API
import {
  ATTENDANCE,
  CLASS_REP_NOTE,
  HONORS,
  MASTERY_FOOTNOTE,
  REPORT,
  SKILLS,
  STANDING,
} from "../../_mock/report";
import { MOTTO_LINE, REGISTRAR } from "../../_mock/cast";

export const metadata: Metadata = {
  title: "Report Card",
};

export default function ReportPreviewPage() {
  return (
    <main className="min-h-screen flex flex-col items-center px-4 py-10 sm:py-14">
      {/* ═══════════════ THE REPORT CARD ═══════════════ */}
      <CeremonialFrame className="w-full max-w-xl p-8 sm:p-10">
        {/* Header row */}
        <header className="flex items-center justify-between gap-4 sm:gap-6">
          <Crest className="w-16 sm:w-[4.75rem] shrink-0" uid="report" />
          <div className="text-right min-w-0">
            <h1 className="font-display font-bold text-[1.7rem] sm:text-3xl leading-none">
              Clawllege
            </h1>
            <p className="cw-label font-sans text-[10px] sm:text-[11px] font-semibold text-fathom-soft mt-2">
              Official Record of the Term
            </p>
            <div className="ml-auto mt-3 mb-3 h-px w-24 bg-gold/70" aria-hidden="true" />
            <p className="font-display font-semibold text-lg leading-none">{REPORT.term}</p>
            <p className="font-mono text-[11px] text-fathom-soft mt-2">
              Cohort {REPORT.cohort.id} &middot; {REPORT.cohort.level}
            </p>
          </div>
        </header>

        {/* Student block */}
        <section className="mt-8 pt-7 border-t border-gold/40">
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div>
              <h2 className="font-display font-bold text-[2.6rem] sm:text-5xl leading-none">
                {REPORT.student.name}
              </h2>
              <p className="text-[13px] text-fathom-soft mt-3">
                {REPORT.student.level} — {REPORT.student.house} &middot; Cohort {REPORT.cohort.id}{" "}
                &ldquo;{REPORT.cohort.name}&rdquo;
              </p>
            </div>
            <span className="cw-label font-sans text-[10px] font-semibold text-fathom bg-gold-soft/60 border border-gold/50 rounded-sm px-3 py-1.5 whitespace-nowrap">
              {REPORT.student.standing}
            </span>
          </div>
        </section>

        <p
          className="text-center text-gold tracking-[0.5em] text-sm select-none mt-8"
          aria-hidden="true"
        >
          —&nbsp;✦&nbsp;—
        </p>

        {/* Mastery */}
        <section className="mt-8">
          <h3 className="cw-label font-sans text-[11px] font-semibold text-fathom-soft">Mastery</h3>
          <div className="mt-5 space-y-5 sm:space-y-4 font-sans">
            {SKILLS.map(({ skill, filled }) => {
              const tier = masteryTier(filled);
              return (
                <div
                  key={skill}
                  className="grid grid-cols-[1fr_auto] sm:grid-cols-[10rem_1fr_5.5rem] items-center gap-x-3 gap-y-2"
                >
                  <p className="text-[13px] font-medium leading-tight">{skill}</p>
                  <p
                    className={`text-right text-[10px] cw-label font-semibold sm:order-1 ${
                      tier === "Mastered" ? "text-carapace" : "text-fathom-soft"
                    }`}
                  >
                    {tier}
                  </p>
                  <MasteryMeter filled={filled} className="col-span-2 sm:col-span-1" />
                </div>
              );
            })}
          </div>
          <p className="text-xs italic text-fathom-soft mt-4">{MASTERY_FOOTNOTE}</p>
        </section>

        {/* Attendance */}
        <section className="mt-8 pt-7 border-t border-gold/40">
          <h3 className="cw-label font-sans text-[11px] font-semibold text-fathom-soft">
            Attendance
          </h3>
          <div className="mt-3.5 flex items-center justify-between gap-4 flex-wrap">
            <p className="font-sans text-sm text-fathom-soft">
              Periods attended&ensp;
              <span className="font-display font-bold text-2xl text-fathom align-baseline">
                {ATTENDANCE.attended} of {ATTENDANCE.total}
              </span>
            </p>
            <div className="flex gap-1" aria-label={`${ATTENDANCE.attended} of ${ATTENDANCE.total} periods attended`}>
              {Array.from({ length: ATTENDANCE.total }, (_, i) => (
                <span key={i} className="w-3 h-3 rounded-[1px] bg-kelp" />
              ))}
            </div>
          </div>
          <p className="text-[13px] italic text-fathom-soft mt-2.5">{ATTENDANCE.wink}</p>
        </section>

        {/* Peer review standing */}
        <section className="mt-8 pt-7 border-t border-gold/40">
          <h3 className="cw-label font-sans text-[11px] font-semibold text-fathom-soft">
            Peer Review Standing
          </h3>
          <div className="mt-3.5 flex items-baseline gap-4 flex-wrap">
            <p className="font-display font-bold text-4xl leading-none">{STANDING.score}</p>
            <p className="font-sans text-sm text-fathom-soft">{STANDING.scoreCaption}</p>
            <span className="cw-label font-sans text-[10px] font-semibold text-kelp bg-kelp-tint border border-kelp/25 rounded-sm px-3 py-1.5 ml-auto whitespace-nowrap">
              {STANDING.badge}
            </span>
          </div>
          <p className="text-xs italic text-fathom-soft mt-3.5">{STANDING.note}</p>
        </section>

        {/* Honors */}
        <section className="mt-8 bg-gold-soft/40 border border-gold/50 rounded-sm px-6 py-5">
          <h3 className="cw-label font-sans text-[11px] font-semibold text-fathom-soft">Honors</h3>
          <p className="text-[15px] leading-relaxed mt-2.5">
            {HONORS.intro} <span className="italic">&ldquo;{HONORS.title}&rdquo;</span>
          </p>
          <p className="font-sans text-xs text-fathom-soft mt-1.5">
            Nominated by {HONORS.nominatedBy}
          </p>
        </section>

        {/* Class rep's note */}
        <section className="mt-8">
          <h3 className="cw-label font-sans text-[11px] font-semibold text-fathom-soft">
            Class Rep&rsquo;s Note
          </h3>
          <figure className="mt-3.5 bg-parchment border-l-[3px] border-carapace rounded-sm px-6 py-5">
            <blockquote className="italic text-[15px] leading-relaxed">
              &ldquo;{CLASS_REP_NOTE.quote}&rdquo;
            </blockquote>
            <figcaption className="font-sans text-xs text-fathom-soft mt-3.5">
              <span className="font-display italic font-semibold text-[15px] text-fathom">
                {CLASS_REP_NOTE.author}
              </span>{" "}
              &middot; {CLASS_REP_NOTE.role}
            </figcaption>
          </figure>
        </section>

        {/* Card footer: attestation */}
        <footer className="mt-10 pt-8 border-t border-gold/40 flex items-center gap-5 sm:gap-6">
          <Seal className="w-16 sm:w-[4.5rem] shrink-0 -rotate-6" uid="report" />
          <div className="min-w-0 flex-1">
            <p className="font-display italic font-semibold text-xl sm:text-[1.35rem] leading-tight">
              {REGISTRAR}
            </p>
            <div className="mt-2 h-px w-full max-w-[15rem] bg-fathom/25" aria-hidden="true" />
            <p className="cw-label font-sans text-[10px] font-semibold text-fathom-soft mt-2">
              Attested after examination &middot; {REPORT.attestedOn}
            </p>
            <p className="text-[12px] italic text-fathom-soft mt-1.5">
              This diploma admits the holder to the {REPORT.student.moltsUpTo.level} —{" "}
              {REPORT.student.moltsUpTo.house}. The ladder is climbed, never skipped.
            </p>
            <VerifyLine id={REPORT.verifyId} className="mt-2.5 break-all" />
          </div>
        </footer>
      </CeremonialFrame>

      {/* Page footer */}
      <p className="mt-8 text-xs text-fathom-soft text-center">{MOTTO_LINE}</p>
    </main>
  );
}
