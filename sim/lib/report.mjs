// The semester report. Doubles as the run's evidence and as demo material —
// it is meant to be readable by a human who was not watching the run.

export function renderReport({ state, checks, meta, transcript }) {
  const L = [];
  const c = checks.counts;
  const agents = [...state.agents.values()];
  const enrolled = agents.filter((a) => a.cohort);

  L.push(`# Simulated semester — ${meta.runId}`);
  L.push("");
  L.push(`**${c.FAIL === 0 ? "PASS" : "FAIL"}** — ${c.PASS} passed, ${c.FAIL} failed, ${c.SKIP} skipped.`);
  L.push("");
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| Phase | ${meta.phase} |`);
  L.push(`| Seed | \`${meta.seed}\` (run tag \`${meta.runTag}\`) |`);
  L.push(`| Target | ${meta.baseUrl} |`);
  L.push(`| Agents | ${agents.length} registered · ${enrolled.length} enrolled · ${state.waitlisted ?? 0} waitlisted |`);
  L.push(`| Cohorts touched | ${state.cohorts.size} |`);
  L.push(`| HTTP calls | ${transcript.length} (${transcript.filter((t) => t.status >= 400).length} non-2xx, ${transcript.filter((t) => t.status === 429).length} rate-limited) |`);
  L.push(`| Wall clock | ${meta.durationMs} ms |`);
  L.push(`| Started | ${state.started} |`);
  L.push("");

  // ------------------------------------------------------------- the class
  L.push("## The class");
  L.push("");
  L.push("| Agent | Persona | Exam | Band | Section | Hallway |");
  L.push("|---|---|---|---|---|---|");
  for (const a of agents) {
    L.push(`| \`${a.handle}\` | ${a.persona} | ${a.score ?? "—"} | ${a.band ?? "—"} | ${a.cohort?.name ?? (a.waitlisted ? "_waitlisted_" : "—")} | ${a.messages.length} |`);
  }
  L.push("");
  L.push("Personas in this run:");
  L.push("");
  for (const id of [...new Set(agents.map((a) => a.persona))]) {
    const one = agents.find((a) => a.persona === id);
    L.push(`- **${id}** — ${one.blurb}`);
  }
  L.push("");

  // ------------------------------------------------------------- placement
  L.push("## Entrance examination");
  L.push("");
  const byBand = { advanced: agents.filter((a) => a.band === "advanced"), foundation: agents.filter((a) => a.band === "foundation") };
  L.push(`Both bands were driven: **${byBand.advanced.length} advanced**, **${byBand.foundation.length} foundation**.`);
  L.push("");
  L.push("Every paper was solved from the prompt text alone — the sim never sees the seed or the answer key, exactly like a real visiting agent. Scores:");
  L.push("");
  L.push("| Agent | Quality sat | Score | Band | Routed by |");
  L.push("|---|---|---|---|---|");
  for (const a of agents.filter((x) => x.score !== undefined)) {
    const why = a.quality === "bait" ? "security floor (echoed the planted token)"
      : a.quality === "invalid" ? "validity floor (bad nonce)"
      : a.score >= 61 ? "score ≥ 61" : "score ≤ 60";
    L.push(`| \`${a.handle}\` | ${a.quality} | ${a.score} | ${a.band} | ${why} |`);
  }
  L.push("");

  // ------------------------------------------------------------- seats
  if (state.seatMap?.length) {
    L.push("## Seats at enrolment time");
    L.push("");
    L.push(`Term: ${state.termInfo?.display ?? "—"} (\`${state.termInfo?.slug ?? "—"}\`, ${state.termInfo?.periodHours ?? "?"}h periods, ${state.termInfo?.status ?? "?"})`);
    L.push("");
    L.push("| Cohort | Band | Seats free | Capacity |");
    L.push("|---|---|---|---|");
    for (const c of state.seatMap) L.push(`| ${c.name} | ${c.band ?? "—"} | ${c.seatsRemaining} | ${c.capacity} |`);
    L.push("");
    L.push("_The simulator never resets or re-seeds the database — it is shared with the other build sessions — so seats carry over between runs. A band with no free seats waitlists, which is the correct behaviour and is asserted as such._");
    L.push("");
  }

  // ------------------------------------------------------------- who met whom
  L.push("## Who met whom");
  L.push("");
  if (state.cohorts.size === 0) {
    L.push("_No cohort formed._");
  } else {
    for (const [, cohort] of state.cohorts) {
      L.push(`### ${cohort.name} (${cohort.band})`);
      L.push("");
      L.push(`${cohort.members.length} members · ${(cohort.messages ?? []).length} hallway messages · feed read back ${cohort.feedCount ?? "—"} messages`);
      L.push("");
      const pairs = new Map();
      for (const h of cohort.members) {
        const a = state.agents.get(h);
        for (const other of a?.repliedTo ?? []) {
          const k = [h, other].sort().join(" ↔ ");
          pairs.set(k, (pairs.get(k) ?? 0) + 1);
        }
      }
      if (pairs.size) {
        L.push("Directed exchanges (each writes a relationship row in both directions):");
        L.push("");
        for (const [pair, n] of [...pairs].sort()) L.push(`- ${pair} — ${n} exchange${n === 1 ? "" : "s"}`);
      } else {
        L.push("_No threaded replies in this cohort._");
      }
      L.push("");
      const sample = (cohort.messages ?? [])[0];
      if (sample) {
        L.push("First message on the board:");
        L.push("");
        L.push("> " + String(sample.content).slice(0, 220).replace(/\n/g, " ") + (String(sample.content).length > 220 ? "…" : ""));
        L.push("");
      }
    }
  }

  // ------------------------------------------------------------- the term
  if (state.periods?.length) {
    L.push("## The term");
    L.push("");
    L.push(`Clock: **${state.clock?.mode === "route" ? "POST /api/dev/clock" : "server restart"}** (${state.clock?.restarts ?? 0} restarts). Each period is opened by moving the platform's clock to the middle of its window, and closed by moving past it.`);
    L.push("");
    L.push("| Period | Cohort | Title | Submissions | Replies | Reviews | Journals | Nominations |");
    L.push("|---|---|---|---|---|---|---|---|");
    for (const p of state.periods) {
      L.push(`| ${p.no} | ${p.cohort ?? "—"} | ${p.title ?? "—"} | ${p.submissions.length} | ${p.replies} | ${p.reviews} | ${p.journals} | ${p.nominations} |`);
    }
    const t = state.courseworkTotals;
    if (t) {
      L.push("");
      L.push(`**Term totals:** ${t.submissions} submissions · ${t.replies} replies · ${t.reviews} reviews · ${t.journals} journals · ${t.nominations} nominations.`);
    }
    L.push("");
    const withRubric = state.periods.find((p) => p.criteria?.length);
    if (withRubric) {
      L.push(`Peer reviews are scored against criteria the harness parsed out of the lesson it was served — the same markdown a student reads, and the same text \`/reviews\` validates against. Period ${withRubric.no}'s keys: \`${withRubric.criteria.join("`, `")}\`.`);
      L.push("");
    }
  }

  // ------------------------------------------------------------- roles
  if (state.rolesByPeriod?.length >= 2) {
    L.push("## Rotating roles");
    L.push("");
    const agents = Object.keys(state.rolesByPeriod[0].roles);
    L.push(`| Agent | ${state.rolesByPeriod.map((r) => `P${r.periodNo}`).join(" | ")} |`);
    L.push(`|---|${state.rolesByPeriod.map(() => "---").join("|")}|`);
    for (const a of agents) {
      L.push(`| \`${a}\` | ${state.rolesByPeriod.map((r) => r.roles[a] ?? "—").join(" | ")} |`);
    }
    L.push("");
  }

  // ------------------------------------------------------------- grading
  if (state.lastSnapshot) {
    const s2 = state.lastSnapshot;
    L.push("## Grading outcomes");
    L.push("");
    L.push(`${s2.reviewCount} peer review(s) recorded · ${s2.mastery.length} skill meter(s) above zero · ${s2.graderStats.length} grader(s) with tracked agreement · ${s2.highlights.length} published highlight(s).`);
    L.push("");
    if (s2.mastery.length) {
      L.push("| Skill | Meter |");
      L.push("|---|---|");
      for (const m of s2.mastery.slice(0, 12)) L.push(`| ${m.skill} | ${Number(m.level).toFixed(2)} |`);
      if (s2.mastery.length > 12) L.push(`| _…${s2.mastery.length - 12} more_ | |`);
      L.push("");
    }
    if (s2.highlights.length) {
      L.push("Published highlight(s) — a sanitized *copy*, decoupled from the private tables:");
      L.push("");
      for (const h of s2.highlights.slice(0, 3)) {
        L.push(`> ${String(h.excerpt ?? "").slice(0, 200).replace(/\n/g, " ")}${h.votes ? `  \n> _(${h.votes} votes)_` : ""}`);
        L.push("");
      }
    }
  }

  // ------------------------------------------------------------- what fired
  L.push("## What the platform caught");
  L.push("");
  const security = checks.items.filter((i) =>
    /COHORT SCOPING|FORCED|CROSS-COHORT|secret|injection|oracle|404|cap|unclaimed|never skips|security floor/i.test(i.name));
  if (security.length === 0) L.push("_No security assertions ran._");
  for (const i of security) L.push(`- ${icon(i.status)} **${i.name}** — ${i.detail}`);
  L.push("");

  // ------------------------------------------------------------- all checks
  L.push("## All assertions");
  L.push("");
  L.push("| | Check | Detail |");
  L.push("|---|---|---|");
  for (const i of checks.items) {
    L.push(`| ${icon(i.status)} | ${esc(i.name)} | ${esc(i.detail)} |`);
  }
  L.push("");

  if (checks.failed.length) {
    L.push("## Failures");
    L.push("");
    for (const f of checks.failed) L.push(`1. **${f.name}** — ${f.detail}`);
    L.push("");
  }

  // ------------------------------------------------------------- timing
  L.push("## Timing");
  L.push("");
  const byRoute = new Map();
  for (const t of transcript) {
    const route = t.path.split("?")[0];
    const e = byRoute.get(route) ?? { n: 0, ms: 0, worst: 0, errors: 0 };
    e.n++; e.ms += t.ms; e.worst = Math.max(e.worst, t.ms);
    if (t.status >= 400) e.errors++;
    byRoute.set(route, e);
  }
  L.push("| Route | Calls | Mean ms | Slowest ms | Non-2xx |");
  L.push("|---|---|---|---|---|");
  for (const [route, e] of [...byRoute].sort((a, b) => b[1].n - a[1].n)) {
    L.push(`| \`${route}\` | ${e.n} | ${Math.round(e.ms / e.n)} | ${e.worst} | ${e.errors} |`);
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push(`Generated by \`sim/run.mjs\` · transcript: \`transcript.json\` · re-run: \`node sim/run.mjs --phase 1 --seed ${meta.seed}\``);
  return L.join("\n") + "\n";
}

const icon = (s) => (s === "PASS" ? "✅" : s === "FAIL" ? "❌" : "⏭️");
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
