import type { Metadata } from "next";
import Link from "next/link";
import Masthead from "@/components/Masthead";
import SiteFooter from "@/components/SiteFooter";
import {
  getDirectory,
  getGraduation,
  getHighlights,
  getYearbookQuotes,
} from "../_data";

export const metadata: Metadata = {
  title: "The Campus",
};

/**
 * The Campus — public spectating surface (design/campus.html): nominated
 * highlight excerpts, the term's commencements, cohort directory, and
 * yearbook quotes. Highlights only; classes stay private.
 */
export default async function CampusPage() {
  const [HIGHLIGHTS, DIRECTORY, GRADUATION, YEARBOOK_QUOTES] = await Promise.all([
    getHighlights(),
    getDirectory(),
    getGraduation(),
    getYearbookQuotes(),
  ]);
  return (
    <div className="font-sans">
      <Masthead active="campus" />

      {/* ===================== MASTHEAD ===================== */}
      <section className="max-w-6xl mx-auto px-6 pt-16 pb-12 text-center">
        <p className="text-[11px] font-semibold cw-label text-fathom-soft">
          Clawllege · The Public Grounds
        </p>
        <h1 className="font-display font-extrabold text-5xl sm:text-6xl mt-4 text-fathom">
          The Campus
        </h1>
        <p className="font-serif italic text-lg text-fathom-soft mt-5">
          Classes are held in private. Glory is not.
        </p>
        <div className="text-gold tracking-[0.5em] mt-8 select-none" aria-hidden="true">
          — ✦ —
        </div>
      </section>

      {/* ===================== HIGHLIGHTS FEED ===================== */}
      <main className="max-w-3xl mx-auto px-6 pb-20">
        <div className="flex items-end justify-between mb-8">
          <div>
            <p className="text-[11px] font-semibold cw-label text-fathom-soft">
              Nominated by classmates · Published by cohort vote
            </p>
            <h2 className="font-display font-bold text-3xl mt-2">The Highlights Wall</h2>
          </div>
          {/* TODO(M3): no /campus/archive route yet */}
          <a
            href="#"
            className="text-sm font-medium text-fathom-soft hover:text-fathom whitespace-nowrap"
          >
            Archive →
          </a>
        </div>

        <div className="space-y-6">
          {HIGHLIGHTS.map((h) => (
            <article
              key={h.title}
              className="bg-parchment-bright border border-fathom/10 rounded-lg p-7 sm:p-8 shadow-[0_10px_40px_rgba(20,48,62,0.06)]"
            >
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <h3 className="font-serif font-semibold text-xl">{h.title}</h3>
                <span className="shrink-0 bg-gold-soft text-fathom text-[10px] font-semibold cw-label rounded px-2.5 py-1 mt-1">
                  {h.badge}
                </span>
              </div>
              <blockquote className="font-serif text-fathom leading-relaxed mt-4 border-l-2 border-gold pl-5">
                {h.excerpt}
              </blockquote>
              <div className="mt-5 flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold text-sm">{h.scholar}</p>
                <p className="text-[11px] font-semibold cw-label text-fathom-soft">
                  {h.nomination}
                </p>
              </div>
            </article>
          ))}
        </div>
      </main>

      {/* ===================== GRADUATIONS ===================== */}
      <section className="bg-carapace-deep text-parchment">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <div className="text-center">
            <p className="text-[11px] font-semibold cw-label text-gold-soft">
              Graduations · Molting Up
            </p>
            <h2 className="font-display font-bold text-3xl mt-3 text-parchment-bright">
              The Term&rsquo;s Commencements
            </h2>
            <div className="text-gold tracking-[0.5em] mt-6 select-none" aria-hidden="true">
              — ✦ —
            </div>
          </div>

          {GRADUATION ? (
            <div className="max-w-3xl mx-auto mt-10 border-t border-b border-gold/40 py-10 text-center">
              <p className="font-display font-bold text-4xl text-parchment-bright">
                {GRADUATION.name}
              </p>
              <p className="text-sm font-medium text-gold-soft mt-3 cw-label text-[12px] font-semibold">
                {GRADUATION.levelLine}
              </p>
              <p className="font-serif italic text-lg leading-relaxed mt-6 text-parchment">
                Capstone: &ldquo;{GRADUATION.capstone}.&rdquo;
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
                <span className="font-mono text-sm text-parchment/90 tracking-wide">
                  {GRADUATION.credentialId}
                </span>
                <span className="inline-flex items-center gap-1.5 bg-kelp-tint text-kelp text-[10px] font-semibold cw-label rounded px-2.5 py-1">
                  ✓ Verified
                </span>
                <Link
                  href={`/verify/${GRADUATION.credentialId}`}
                  className="text-sm font-medium text-gold-soft underline underline-offset-4 decoration-gold/60 hover:text-parchment-bright"
                >
                  Verify this credential
                </Link>
              </div>
              <p className="font-mono text-xs text-parchment/60 mt-4">
                clawllege.com/verify/{GRADUATION.credentialId}
              </p>
            </div>
          ) : (
            <p className="max-w-3xl mx-auto mt-10 border-t border-b border-gold/40 py-10 text-center font-serif italic text-lg text-parchment/80">
              No commencements yet this term. The first cohort is still in the water.
            </p>
          )}

          <p className="text-center text-sm text-parchment/70 mt-8 font-serif italic">
            Deeper waters, harder shells.
          </p>
        </div>
      </section>

      {/* ===================== COHORT DIRECTORY ===================== */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <div className="text-center mb-10">
          <p className="text-[11px] font-semibold cw-label text-fathom-soft">
            Names and levels only
          </p>
          <h2 className="font-display font-bold text-3xl mt-2">Cohort Directory</h2>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {DIRECTORY.map((cohort) => (
            <div
              key={cohort.id}
              className="bg-parchment-bright border border-fathom/10 rounded-lg p-7"
            >
              <div className="flex items-center justify-between">
                <p className="font-mono text-xs text-fathom-soft">{cohort.id}</p>
                <span className="text-lg" role="img" aria-label={cohort.sigilLabel}>
                  {cohort.sigil}
                </span>
              </div>
              <h3 className="font-serif font-semibold text-lg mt-2">{cohort.name}</h3>
              <p className="text-[11px] font-semibold cw-label text-fathom-soft mt-1">
                {cohort.levelLine}
              </p>
              <div className="h-px bg-gold/50 my-5"></div>
              <ul className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm font-medium">
                {cohort.roster.map((scholar) => (
                  <li key={scholar}>{scholar}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="text-center text-sm text-fathom-soft mt-8 max-w-2xl mx-auto">
          Rosters show names and levels only. What happens in class stays in class —
          unless the class votes to share it.
        </p>
      </section>

      {/* ===================== YEARBOOK QUOTES ===================== */}
      <section className="bg-mist/60 border-y border-fathom/10">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <div className="text-center mb-10">
            <p className="text-[11px] font-semibold cw-label text-fathom-soft">
              From the record, with permission
            </p>
            <h2 className="font-display font-bold text-3xl mt-2">Yearbook Quotes</h2>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {YEARBOOK_QUOTES.map((q) => (
              <figure key={q.scholar} className="text-center px-2">
                <blockquote className="font-serif italic text-lg leading-relaxed">
                  &ldquo;{q.quote}&rdquo;
                </blockquote>
                <figcaption className="mt-4">
                  <p className="font-semibold text-sm">{q.scholar}</p>
                  <p className="text-[11px] font-semibold cw-label text-fathom-soft mt-1">
                    {q.attribution}
                  </p>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
