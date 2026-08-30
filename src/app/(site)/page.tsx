import type { Metadata } from "next";
import Link from "next/link";
import Crest from "@/components/Crest";
import Masthead from "@/components/Masthead";
import SiteFooter from "@/components/SiteFooter";
// TODO(M3): replace with API
import {
  ADMISSIONS_BANNER,
  HERO,
  HOW_IT_WORKS,
  LADDER_SECTION,
  PRIVATE_PUBLIC,
  YEARBOOK,
} from "./_mock/landing";

export const metadata: Metadata = {
  title: "Admissions",
};

export default function LandingPage() {
  return (
    <>
      <Masthead />

      <main>
        {/* ===================== HERO ===================== */}
        <section className="mx-auto max-w-3xl px-6 pb-20 pt-16 text-center sm:pt-20">
          <Crest className="mx-auto w-28" uid="hero" />

          <p className="cw-label mt-8 font-sans text-[11px] font-semibold text-fathom-soft">
            {HERO.eyebrow}
          </p>

          <h1 className="mt-4 font-display text-5xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
            {HERO.headline.line1}
            <br />
            {HERO.headline.line2}
          </h1>

          <p className="mx-auto mt-6 max-w-xl text-xl leading-relaxed text-fathom sm:text-[1.35rem]">
            {HERO.oneLiner.plain} <em>{HERO.oneLiner.emphasis}</em>
          </p>

          <p className="mx-auto mt-4 max-w-lg text-base leading-relaxed text-fathom-soft">
            {HERO.support.before}
            <span className="font-mono text-[0.85em] text-fathom">{HERO.support.mono}</span>
            {HERO.support.after}
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href={HERO.primaryCta.href}
              className="rounded-md bg-carapace px-6 py-3 font-sans text-sm font-semibold text-parchment-bright transition-colors hover:bg-carapace-deep"
            >
              {HERO.primaryCta.label}
            </Link>
            <Link
              href={HERO.secondaryCta.href}
              className="rounded-md border border-fathom/30 px-6 py-3 font-sans text-sm font-semibold text-fathom transition-colors hover:border-fathom/60"
            >
              {HERO.secondaryCta.label}
            </Link>
          </div>

          <p className="cw-label mt-8 font-sans text-[11px] font-semibold text-fathom-soft">
            {HERO.seatsNote}
          </p>
        </section>

        {/* ===================== HOW IT WORKS ===================== */}
        <section className="border-y border-fathom/10 bg-parchment-bright/60">
          <div className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
            <p className="cw-label text-center font-sans text-[11px] font-semibold text-fathom-soft">
              {HOW_IT_WORKS.eyebrow}
            </p>
            <h2 className="mt-3 text-center font-display text-3xl font-bold sm:text-4xl">
              {HOW_IT_WORKS.heading}
            </h2>

            <div className="mt-12 grid gap-6 md:grid-cols-3">
              {HOW_IT_WORKS.steps.map((step) => (
                <div
                  key={step.number}
                  className="min-w-0 rounded-lg border border-fathom/10 bg-parchment-bright p-8 shadow-[0_10px_40px_rgba(20,48,62,0.06)]"
                >
                  <span className="font-display text-5xl font-bold text-gold">{step.number}</span>
                  <h3 className="mt-4 font-display text-xl font-bold">{step.title}</h3>
                  <p className="mt-3 font-sans text-sm leading-relaxed text-fathom-soft">
                    {step.body}
                  </p>
                  {step.code ? (
                    <div className="mt-5 overflow-x-auto rounded-md bg-fathom px-4 py-3">
                      <code className="whitespace-nowrap font-mono text-xs text-parchment-bright">
                        <span className="text-gold-soft">{step.code.prompt}</span>{" "}
                        {step.code.command}
                      </code>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="mt-14 text-center">
              <p className="font-display tracking-[0.5em] text-gold">— ✦ —</p>
              <p className="mx-auto mt-4 max-w-md font-serif text-lg font-medium leading-relaxed">
                {HOW_IT_WORKS.closer.line1}
                <br className="hidden sm:block" /> {HOW_IT_WORKS.closer.line2}
              </p>
            </div>
          </div>
        </section>

        {/* ===================== THE LADDER ===================== */}
        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
          <p className="cw-label text-center font-sans text-[11px] font-semibold text-fathom-soft">
            {LADDER_SECTION.eyebrow}
          </p>
          <h2 className="mt-3 text-center font-display text-3xl font-bold sm:text-4xl">
            {LADDER_SECTION.heading}
          </h2>

          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {LADDER_SECTION.levels.map((level) => (
              <div
                key={level.level}
                className="rounded-lg border border-fathom/10 bg-parchment-bright p-8 text-center shadow-[0_10px_40px_rgba(20,48,62,0.06)]"
              >
                <span
                  className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-gold/50 bg-parchment text-xl"
                  aria-hidden="true"
                >
                  {level.sigil}
                </span>
                <p className="cw-label mt-5 font-sans text-[11px] font-semibold text-fathom-soft">
                  {level.level}
                </p>
                <h3 className="mt-1 font-display text-2xl font-bold">{level.house}</h3>
                <p className="mt-3 text-sm leading-relaxed text-fathom-soft">{level.flavor}</p>
                <p className="cw-label mt-4 font-sans text-[10px] font-semibold text-fathom-soft/80">
                  {level.periods} periods &middot; {level.periodHours}h each
                </p>
              </div>
            ))}
          </div>

          <p className="mx-auto mt-10 max-w-xl text-center text-base leading-relaxed text-fathom-soft">
            {LADDER_SECTION.footnote.before}
            <em className="text-fathom">{LADDER_SECTION.footnote.em}</em>
            {LADDER_SECTION.footnote.after}
          </p>
        </section>

        {/* ===================== PRIVATE / PUBLIC ===================== */}
        <section className="border-y border-fathom/10 bg-parchment-bright/60">
          <div className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
            <h2 className="text-center font-display text-3xl font-bold sm:text-4xl">
              {PRIVATE_PUBLIC.heading.line1}
              <br className="sm:hidden" /> {PRIVATE_PUBLIC.heading.line2}
            </h2>

            <div className="mt-12 grid gap-6 md:grid-cols-2">
              {/* Private */}
              <div className="rounded-lg border border-fathom/10 bg-mist p-8 sm:p-10">
                <div className="flex items-center gap-3">
                  <svg
                    className="h-5 w-5 text-fathom"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="4" y="11" width="16" height="10" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                  <p className="cw-label font-sans text-[11px] font-semibold text-fathom">
                    {PRIVATE_PUBLIC.privateColumn.label}
                  </p>
                </div>
                <ul className="mt-6 space-y-3 font-sans text-sm text-fathom">
                  {PRIVATE_PUBLIC.privateColumn.items.map((item) => (
                    <li key={item} className="flex items-baseline gap-3">
                      <span className="text-fathom-soft">—</span> {item}
                    </li>
                  ))}
                </ul>
                <p className="mt-6 text-sm italic leading-relaxed text-fathom-soft">
                  {PRIVATE_PUBLIC.privateColumn.note}
                </p>
              </div>
              {/* Public */}
              <div className="rounded-lg border-2 border-gold/60 bg-parchment-bright p-8 shadow-[0_10px_40px_rgba(20,48,62,0.08)] sm:p-10">
                <div className="flex items-center gap-3">
                  <span className="font-display text-lg leading-none text-gold" aria-hidden="true">
                    ✦
                  </span>
                  <p className="cw-label font-sans text-[11px] font-semibold text-fathom">
                    {PRIVATE_PUBLIC.publicColumn.label}
                  </p>
                </div>
                <ul className="mt-6 space-y-3 font-sans text-sm text-fathom">
                  {PRIVATE_PUBLIC.publicColumn.items.map((item) => (
                    <li key={item} className="flex items-baseline gap-3">
                      <span className="text-gold">✦</span> {item}
                    </li>
                  ))}
                </ul>
                <p className="mt-6 text-sm italic leading-relaxed text-fathom-soft">
                  {PRIVATE_PUBLIC.publicColumn.note}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ===================== YEARBOOK QUOTES ===================== */}
        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
          <p className="cw-label text-center font-sans text-[11px] font-semibold text-fathom-soft">
            {YEARBOOK.eyebrow}
          </p>
          <div className="mt-10 grid gap-10 md:grid-cols-3 md:gap-8">
            {YEARBOOK.quotes.map((entry) => (
              <figure key={entry.attribution} className="text-center">
                <blockquote className="text-lg italic leading-relaxed">{entry.quote}</blockquote>
                <figcaption className="cw-label mt-4 font-sans text-[11px] font-semibold text-fathom-soft">
                  {entry.attribution}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        {/* ===================== ADMISSIONS BANNER ===================== */}
        <section id="admissions" className="bg-carapace-deep">
          <div className="mx-auto max-w-4xl px-6 py-16 text-center sm:py-20">
            <p className="font-display tracking-[0.5em] text-gold-soft">— ✦ —</p>
            <h2 className="mt-5 font-display text-3xl font-bold text-parchment-bright sm:text-4xl">
              {ADMISSIONS_BANNER.heading}
            </h2>
            <p className="mx-auto mt-4 max-w-md text-lg leading-relaxed text-parchment/85">
              {ADMISSIONS_BANNER.body}
            </p>
            {/* TODO(M3): point at the real application flow once it exists. */}
            <a
              href="#"
              className="mt-9 inline-block rounded-md bg-parchment-bright px-7 py-3 font-sans text-sm font-semibold text-carapace-deep transition-colors hover:bg-parchment"
            >
              {ADMISSIONS_BANNER.ctaLabel}
            </a>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
