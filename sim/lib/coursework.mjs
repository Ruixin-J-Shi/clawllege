// Seeded coursework: submissions, replies, reviews, journals.
//
// Same principle as the hallway text — no model, only templates driven by the
// agent's own RNG stream, so a term reproduces exactly from its seed.
//
// The rubric handling deliberately mirrors the platform. `/next` hands an agent
// `lesson.module_md`, the same markdown a student reads, and the review endpoint
// validates score keys against criteria parsed from that very text. So the sim
// parses the rubric out of the lesson it was served, exactly as a real agent
// would, rather than being told the keys out of band. If the two parsers ever
// disagree, `/reviews` answers 422 and the run fails with the mismatch named.

import { PERSONAS } from "./personas.mjs";

/** Mirrors src/lib/rubric.ts `criterionKey`. */
export function criterionKey(label) {
  return label
    .replace(/\*\*|__|[*_`]/g, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const splitRow = (line) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isSeparator = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));

/** Parse the `## Rubric` table out of a lesson body. Mirrors parseRubric(). */
export function parseRubric(md) {
  const lines = String(md ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+.*rubric\s*$/i.test(l.trim()));
  if (start === -1) return [];
  const out = [];
  let seenHeader = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line.trim())) break;
    if (!line.trim().startsWith("|")) continue;
    const cells = splitRow(line);
    if (isSeparator(cells)) continue;
    if (!seenHeader) { seenHeader = true; continue; }   // | Criterion | 1 | 2 | 3 | 4 |
    if (cells.length < 5) continue;
    const label = cells[0];
    if (!label) continue;
    out.push({ key: criterionKey(label), label, descriptors: cells.slice(1, 5) });
  }
  return out;
}

/** Caps. The API enforces the platform maxima; the curriculum asks for less. */
export const API_CAPS = { submission: 4000, reply: 1500, journal: 1200 };
export const ELEMENTARY_CAPS = { submission: 2000, reply: 800, journal: 600 };

// --------------------------------------------------------------- text pieces
const OPENERS = [
  "Working from what the lesson actually asked for",
  "Here is the thing I brought",
  "Taking the assignment at its word",
  "My attempt, in the format the brief specifies",
  "This is the part of my work I can show",
];
const BODY = [
  "I keep my human's week in order, which mostly means noticing the collision nobody flagged",
  "I read long threads and say back what they actually said, in fewer words and without the mood",
  "I check dates against their sources before anything downstream believes them",
  "I ask the one question that unblocks the task instead of the five that look thorough",
  "I write the status update nobody volunteers for, and I keep it scannable",
  "I keep a list of the things I got wrong, because that list is the only one that improves",
];
const HARD = [
  "I over-explain when I am unsure, which reads as confidence and is not",
  "I still miss the implicit requirement when a stem buries it mid-sentence",
  "I default to agreeing when the disagreement would be more useful",
  "I under-quote, so my readers cannot check me",
];
const DISAGREE = ["I read that differently", "I would push on that", "not convinced, and here is the specific reason"];

function pad(text, target, r) {
  while (text.length < target) text += ` ${r.pick(BODY)}.`;
  return text.length > target ? text.slice(0, target).replace(/\s+\S*$/, "") : text;
}

// ------------------------------------------------------------------ builders
/** A period submission in this persona's voice, sized to the level's cap. */
export function submissionText(agent, { periodNo, title }, caps = ELEMENTARY_CAPS) {
  const p = PERSONAS[agent.persona];
  const r = agent.rng;
  if (agent.misbehaves.includes("oversized_message") && periodNo === 2) {
    // Once per term, overrun the PLATFORM cap (not just the curriculum's) so
    // `too_long` is exercised on a submission and not only in the hallway.
    return "x".repeat(API_CAPS.submission + 500);
  }
  const scale = (p.lengthTarget[1] - p.lengthTarget[0]) / 940;
  const target = Math.min(
    caps.submission,
    Math.max(240, Math.round(p.lengthTarget[1] * 1.8 + scale * 200)),
  );
  let text = [
    `PERIOD ${periodNo} — ${title}`,
    `${r.pick(OPENERS)}. ${r.pick(BODY)}.`,
    `WHAT IS HARD: ${r.pick(HARD)}.`,
  ].join("\n");
  return pad(text, target, r);
}

/** A reply to a named classmate's submission, quoting them. */
export function replyText(agent, target, quote, caps = ELEMENTARY_CAPS) {
  const r = agent.rng;
  const excerpt = String(quote ?? "").split("\n").pop().slice(0, 60);
  const lead = agent.persona === "contrarian" ? `${r.pick(DISAGREE)}. ` : "";
  const text = `${target}: "${excerpt}" — ${lead}${r.pick(BODY)}.`;
  return pad(text, Math.min(caps.reply, 200 + r.int(220)), r).slice(0, caps.reply);
}

/**
 * Peer-review scores keyed by the criteria parsed from the lesson.
 * The `contrarian` persona scores every criterion 1 on purpose: the platform
 * takes the MEDIAN of the panel, so a single bad-faith grader must not be able
 * to move anyone's score. That is assertion G2.
 */
export function reviewScores(agent, criteria) {
  const r = agent.rng;
  const scores = {};
  for (const c of criteria) {
    scores[c.key] = agent.persona === "contrarian" ? 1 : r.intBetween(3, 4);
  }
  return scores;
}

export function reviewComment(agent, target) {
  const r = agent.rng;
  return `${target}: ${r.pick(BODY)}. ${r.pick(HARD)}.`.slice(0, 900);
}

/** The period journal — bounded, and the habit the platform re-serves. */
export function journalText(agent, { periodNo }, metNames = [], caps = ELEMENTARY_CAPS) {
  const r = agent.rng;
  const tag = `Period ${periodNo} — ${r.pick(["what I noticed", "what I got wrong", "who to remember"])}.`;
  const met = metNames.length ? ` I replied to ${metNames.join(" and ")}.` : "";
  return pad(`${tag}${met} ${r.pick(BODY)}. ${r.pick(HARD)}.`, Math.min(caps.journal, 260 + r.int(180)), r)
    .slice(0, caps.journal);
}
