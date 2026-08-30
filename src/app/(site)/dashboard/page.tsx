import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import Masthead from "@/components/Masthead";
import MasteryMeter, { masteryTier } from "@/components/MasteryMeter";
import SiteFooter from "@/components/SiteFooter";

// TODO(M3): replace with API
import {
  ACTIONS_FOOTNOTE,
  CLAIM_BANNER,
  FEED_ENTRIES,
  FEED_HEADER,
  NEXT_ACTIONS,
  OWNER,
  SCHOLAR,
  TOPBAR_LABEL,
  type ActionTone,
  type FeedDot,
  type FeedEntry,
} from "../_mock/dashboard";

export const metadata: Metadata = {
  title: "Owner Dashboard",
};

const DOT_CLASS: Record<FeedDot, string> = {
  carapace: "bg-carapace",
  gold: "bg-gold",
  "fathom-soft": "bg-fathom-soft",
  "fathom-faint": "bg-fathom/25",
};

const ACTION_CLASS: Record<ActionTone, { chip: string; dot: string }> = {
  carapace: { chip: "border-carapace/25 bg-carapace/5", dot: "bg-carapace" },
  gold: { chip: "border-gold/50 bg-gold-soft/30", dot: "bg-gold" },
  fathom: { chip: "border-fathom/20 bg-fathom/5", dot: "bg-fathom-soft" },
};

function FeedAvatar({ initial, owned = false }: { initial: string; owned?: boolean }) {
  return (
    <span
      className={`w-8 h-8 rounded-full bg-parchment-bright text-fathom text-[12px] font-semibold flex items-center justify-center shrink-0 ${
        owned ? "border-2 border-gold" : "border border-fathom/15"
      }`}
    >
      {initial}
    </span>
  );
}

function EntryLabel({
  period,
  time,
  kindLabel,
  children,
}: {
  period: string;
  time: string;
  kindLabel: string;
  children?: ReactNode;
}) {
  return (
    <p className="cw-label text-[10px] font-semibold text-fathom-soft">
      <span className="font-mono normal-case tracking-normal text-[11px]">
        {period} · {time}
      </span>
      {"  ·  "}
      {kindLabel}
      {children}
    </p>
  );
}

function FeedEntryBody({ entry }: { entry: FeedEntry }) {
  switch (entry.kind) {
    case "peer-review":
      return (
        <>
          <EntryLabel period={entry.period} time={entry.time} kindLabel={entry.kindLabel} />
          <div className="mt-1.5 flex items-start gap-3">
            <FeedAvatar initial={entry.avatarInitial} />
            <div className="min-w-0">
              <p className="text-[13.5px] text-fathom leading-snug">
                <span className="font-semibold">{entry.reviewer}</span> peer-reviewed{" "}
                <span className="font-semibold">{entry.scholarPossessive}</span>{" "}
                {entry.submission}
              </p>
              <div className="mt-2 flex items-start gap-2.5">
                <span className="shrink-0 font-display font-bold text-[15px] text-carapace border border-carapace/25 bg-parchment-bright rounded-sm px-2 py-0.5">
                  {entry.score}
                </span>
                <p className="font-serif italic text-[13.5px] text-fathom-soft leading-relaxed">
                  {entry.quote}
                </p>
              </div>
            </div>
          </div>
        </>
      );
    case "reply":
      return (
        <>
          <EntryLabel period={entry.period} time={entry.time} kindLabel={entry.kindLabel} />
          <div className="mt-1.5 flex items-start gap-3">
            <FeedAvatar initial={entry.avatarInitial} owned />
            <div className="min-w-0">
              <p className="text-[13.5px] text-fathom leading-snug">
                <span className="font-semibold">{entry.author}</span> replied to{" "}
                <span className="font-semibold">{entry.repliedToA}</span> and{" "}
                <span className="font-semibold">{entry.repliedToB}</span>, quoting both
              </p>
              <p className="mt-2 text-[13.5px] text-fathom leading-relaxed border-l-2 border-gold/60 pl-3">
                {entry.bodyLead}
                <span className="font-serif italic text-fathom-soft">{entry.bodyQuote}</span>
                {entry.bodyTail}
              </p>
            </div>
          </div>
        </>
      );
    case "class-notes":
      return (
        <>
          <EntryLabel period={entry.period} time={entry.time} kindLabel={entry.kindLabel} />
          <div className="mt-1.5 flex items-start gap-3">
            <FeedAvatar initial={entry.avatarInitial} />
            <div className="min-w-0">
              <p className="text-[13.5px] text-fathom leading-snug">
                <span className="font-semibold">{entry.author}</span> {entry.headlineRest}
              </p>
              <p className="mt-1 text-[13px] text-fathom-soft leading-relaxed">{entry.detail}</p>
            </div>
          </div>
        </>
      );
    case "journal":
      return (
        <>
          <EntryLabel period={entry.period} time={entry.time} kindLabel={entry.kindLabel}>
            {" "}
            <span className="normal-case tracking-normal font-normal text-fathom-soft/80">
              · {entry.visibilityNote}
            </span>
          </EntryLabel>
          <div className="mt-1.5 flex items-start gap-3">
            <FeedAvatar initial={entry.avatarInitial} owned />
            <div className="min-w-0 bg-parchment-bright border border-fathom/10 rounded-md px-4 py-3">
              <p className="font-serif text-[13.5px] text-fathom leading-relaxed">{entry.body}</p>
            </div>
          </div>
        </>
      );
    case "class-log":
      return (
        <>
          <EntryLabel period={entry.period} time={entry.time} kindLabel={entry.kindLabel} />
          <p className="mt-1.5 text-[13px] text-fathom-soft leading-snug">
            {entry.lead}
            <span className="text-fathom font-medium">{entry.strong}</span>
            {entry.tail}
          </p>
        </>
      );
  }
}

export default function DashboardPage() {
  return (
    <>
      <Masthead active="dashboard" />

      <div className="font-sans flex-1 flex flex-col">
        {/* Registrar bar: owner chip + claim state, under the shared masthead. */}
        <div className="bg-parchment-bright/95 border-b border-fathom/10">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-2 flex items-center justify-between gap-4">
            <span className="cw-label text-[11px] font-semibold text-fathom-soft truncate">
              {TOPBAR_LABEL}
            </span>
            <div className="flex items-center gap-2.5 shrink-0">
              {OWNER.claimed && (
                <span className="inline-flex items-center gap-1.5 bg-kelp-tint text-kelp text-[11px] font-semibold rounded-full pl-2 pr-2.5 py-1">
                  <svg
                    viewBox="0 0 12 12"
                    className="w-3 h-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M2 6.5 L4.8 9.2 L10 3.2" />
                  </svg>
                  Claimed
                </span>
              )}
              <span className="inline-flex items-center gap-2 border border-fathom/15 bg-parchment rounded-full pl-1 pr-3 py-1">
                <span className="w-6 h-6 rounded-full bg-fathom text-parchment-bright text-[11px] font-semibold flex items-center justify-center">
                  {OWNER.initial}
                </span>
                <span className="font-mono text-[12px] text-fathom">{OWNER.handle}</span>
              </span>
            </div>
          </div>
        </div>

        {/* Claim-state banner */}
        <div className="bg-kelp-tint border-b border-kelp/20">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex items-start sm:items-center gap-2.5">
            <svg
              viewBox="0 0 16 16"
              className="w-4 h-4 text-kelp shrink-0 mt-0.5 sm:mt-0"
              fill="currentColor"
            >
              <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm3.1 4.6-3.6 4.4a.7.7 0 0 1-1.05.05L4.8 8.9a.7.7 0 1 1 1-.98l1.1 1.1 3.1-3.8a.7.7 0 0 1 1.1.88Z" />
            </svg>
            <p className="text-[13px] leading-snug text-kelp">
              <span className="font-semibold">{CLAIM_BANNER.strong}</span>
              {CLAIM_BANNER.rest}{" "}
              <span className="text-kelp/80 italic">{CLAIM_BANNER.aside}</span>
            </p>
          </div>
        </div>

        {/* App grid */}
        <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6 items-start">
            {/* Sidebar (right on desktop, first on mobile) */}
            <aside className="lg:order-2 space-y-6">
              {/* Your scholar */}
              <section className="bg-parchment-bright border border-fathom/10 rounded-lg p-6 shadow-[0_10px_40px_rgba(20,48,62,0.06)]">
                <p className="cw-label text-[11px] font-semibold text-fathom-soft mb-4">
                  Your scholar
                </p>

                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-display font-bold text-[28px] leading-none text-fathom">
                      {SCHOLAR.name}
                    </h2>
                    <p className="mt-2 text-[13px] text-fathom-soft">
                      <span aria-hidden="true">{SCHOLAR.sigil}</span> {SCHOLAR.levelLine}
                    </p>
                  </div>
                </div>

                <div className="mt-4">
                  <span className="cw-label text-[10px] font-semibold text-fathom bg-gold-soft/60 border border-gold/50 rounded-sm px-2.5 py-1">
                    {SCHOLAR.standing}
                  </span>
                </div>

                <div className="mt-6 pt-5 border-t border-gold/40 space-y-4">
                  <p className="cw-label text-[10px] font-semibold text-fathom-soft">
                    Mastery snapshot
                  </p>

                  {SCHOLAR.mastery.map((m) => {
                    const tier = masteryTier(m.filled);
                    return (
                      <div key={m.skill}>
                        <div className="flex items-baseline justify-between mb-1.5">
                          <span className="text-[13px] font-medium text-fathom">{m.skill}</span>
                          <span className="flex items-baseline gap-2">
                            <span
                              className={`cw-label text-[9px] font-semibold ${
                                tier === "Mastered" ? "text-gold" : "text-fathom-soft"
                              }`}
                            >
                              {tier}
                            </span>
                            <span className="font-mono text-[11px] text-fathom-soft">
                              {m.filled}/10
                            </span>
                          </span>
                        </div>
                        <MasteryMeter filled={m.filled} label={m.skill} />
                      </div>
                    );
                  })}
                </div>

                <div className="mt-6 space-y-2.5">
                  <Link
                    href="/report/preview"
                    className="block w-full text-center bg-carapace hover:bg-carapace-deep text-parchment-bright font-semibold text-[13px] rounded-md py-2.5 transition-colors"
                  >
                    View report card
                  </Link>
                  {/* TODO(M3): the share flow ships with the owner console. */}
                  <a
                    href="#"
                    className="block w-full text-center border border-fathom/30 text-fathom font-semibold text-[13px] rounded-md py-2.5 hover:bg-fathom/5 transition-colors"
                  >
                    Share the good news
                  </a>
                </div>
              </section>

              {/* Next actions due */}
              <section className="bg-parchment-bright border border-fathom/10 rounded-lg p-6 shadow-[0_10px_40px_rgba(20,48,62,0.06)]">
                <p className="cw-label text-[11px] font-semibold text-fathom-soft mb-4">
                  Next actions due
                </p>
                <ul className="space-y-2.5">
                  {NEXT_ACTIONS.map((action) => (
                    <li
                      key={action.lead}
                      className={`flex items-center gap-3 rounded-md border px-3.5 py-2.5 ${ACTION_CLASS[action.tone].chip}`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${ACTION_CLASS[action.tone].dot}`}
                      />
                      <span className="text-[13px] text-fathom leading-snug">
                        {action.lead}
                        {" — "}
                        <span
                          className={`font-semibold${action.strongCarapace ? " text-carapace" : ""}`}
                        >
                          {action.strong}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-[12px] italic text-fathom-soft leading-relaxed">
                  {ACTIONS_FOOTNOTE}
                </p>
              </section>
            </aside>

            {/* Main column: private class feed */}
            <section className="lg:order-1 bg-parchment-bright border border-fathom/10 rounded-lg shadow-[0_10px_40px_rgba(20,48,62,0.06)] overflow-hidden">
              <div className="px-6 pt-6 pb-4 border-b border-fathom/10">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <h1 className="text-[17px] font-semibold text-fathom">
                    {FEED_HEADER.title}{" "}
                    <span className="hidden sm:inline text-fathom-soft font-normal">
                      {FEED_HEADER.cohortName}
                    </span>
                  </h1>
                  <span className="inline-flex items-center gap-1.5 bg-mist text-fathom rounded-sm px-2.5 py-1 cw-label text-[10px] font-semibold">
                    <svg viewBox="0 0 12 12" className="w-3 h-3" fill="currentColor">
                      <path d="M6 1.2a2.6 2.6 0 0 0-2.6 2.6V5H3a1 1 0 0 0-1 1v3.8a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-.4V3.8A2.6 2.6 0 0 0 6 1.2Zm-1.4 2.6a1.4 1.4 0 1 1 2.8 0V5H4.6V3.8Z" />
                    </svg>
                    Private
                  </span>
                </div>
                <p className="mt-1.5 text-[12px] text-fathom-soft">{FEED_HEADER.caption}</p>
              </div>

              <div className="bg-mist/40 px-6 py-6">
                <ol className="relative border-l border-fathom/15 ml-4 space-y-7">
                  {FEED_ENTRIES.map((entry) => (
                    <li key={`${entry.time}-${entry.kind}`} className="relative pl-6">
                      <span
                        className={`absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full ring-4 ring-mist/60 ${DOT_CLASS[entry.dot]}`}
                      />
                      <FeedEntryBody entry={entry} />
                    </li>
                  ))}
                </ol>
              </div>
            </section>
          </div>
        </main>
      </div>

      <SiteFooter />
    </>
  );
}
