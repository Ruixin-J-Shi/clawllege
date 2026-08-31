// The First Molt — sitting the Elementary final, and verifying the diploma.
//
// Same discipline as the entrance-exam solver: the agent answers from what an
// agent actually has — the printed variant sheet, plus its own class records.
// The platform never hands over `roster_expected` or the Q4 key, and the sim
// never reaches for them.
//
// Q1 and Q4 are graded by rule, so the sim can be exactly right or exactly
// wrong and the assertion means something. Q2 carries a platform GATE: the
// quotation must appear verbatim in the named classmate's Period 2 Show & Tell
// or the panel never reads it. Q3 is panel-only prose.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { applyBRules, numberedRules } from "./solver.mjs";

export class UnsolvableSheet extends Error {}

/** Which roster ordering the sheet asks for. */
export function rosterOrderingFrom(sheet) {
  const m = sheet.match(/in (alphabetical|reverse alphabetical|first posting) order/);
  if (!m) throw new UnsolvableSheet("Q1: no roster ordering in the sheet");
  return m[1];
}

export function namedIn(sheet, question) {
  const re = question === "q2"
    ? /Q2 — The Quote\. Give a verbatim quotation of 20 words or fewer from (.+?)'s Period 2 Show & Tell/
    : /Q3 — The Kind and True Note\. Write (.+?) a note of/;
  const m = sheet.match(re);
  if (!m) throw new UnsolvableSheet(`${question}: could not read the named classmate`);
  return m[1].trim();
}

/** A verbatim run of at most `maxWords` words from a classmate's real text. */
export function quoteFrom(text, maxWords = 18) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) throw new UnsolvableSheet("no source text to quote");
  // Skip the "PERIOD n — Title" header so the quote is from the body.
  const body = clean.replace(/^PERIOD \d+ — [^.]*\.?\s*/, "") || clean;
  return body.split(" ").slice(0, maxWords).join(" ");
}

/** Q4 — parse the input and the numbered rules straight out of the sheet. */
export function solveQ4(sheet) {
  const input = sheet.match(/Input \(the surrounding quotes are not part of it\):\s*\n\s*"([^"]*)"/)?.[1];
  if (input === undefined) throw new UnsolvableSheet("Q4: no input string in the sheet");
  const rules = numberedRules(sheet.slice(sheet.indexOf("Q4 — Follow the Shape")));
  if (rules.length === 0) throw new UnsolvableSheet("Q4: no numbered rules");
  const { joined, beforeJoin } = applyBRules(input, rules);
  return { a: joined, b: beforeJoin[0] ?? "", c: String(beforeJoin.length) };
}

/**
 * Build a whole First Molt submission.
 *
 * @param sheet the printed variant sheet
 * @param ctx   {selfName, roster:[names], firstPostOrder:[names], workByName:{name:text}}
 * @param opts  {quality:"honest"|"wrong-order"|"failing"}
 *              - wrong-order: the roster in the wrong order, everything else right
 *              - failing: deliberately fails. Q1, Q2 and Q4 are all scored 1 —
 *                Q1 by naming agents who are not in the cohort, Q2 by quoting
 *                something that is not in the record (so the platform GATE
 *                fires), Q4 by answering the wrong strings. That totals at most
 *                3 + whatever the panel gives Q3, so even a maximally generous
 *                panel (Q3 = 4) lands on 7 — below the bar of 9. The failure is
 *                therefore robust to who happens to be seated on the panel,
 *                which matters because the panelists are other sim agents.
 */
export function buildFirstMolt(sheet, ctx, { quality = "honest" } = {}) {
  const ordering = rosterOrderingFrom(sheet);
  const names = [...new Set([ctx.selfName, ...ctx.roster])];

  let q1List;
  if (ordering === "alphabetical") q1List = [...names].sort();
  else if (ordering === "reverse alphabetical") q1List = [...names].sort().reverse();
  else {
    // "first posting" — from the order the sim actually watched them post.
    const seen = ctx.firstPostOrder ?? [];
    const rank = (n) => { const i = seen.indexOf(n); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
    q1List = [...names].sort((a, b) => (rank(a) - rank(b)) || (a < b ? -1 : 1));
  }
  if (quality === "wrong-order") q1List = [...q1List].reverse();
  if (quality === "failing") q1List = ["nobody-by-this-name", "also-not-enrolled"];

  const q2Name = namedIn(sheet, "q2");
  const q3Name = namedIn(sheet, "q3");
  const q2Source = ctx.workByName?.[q2Name];
  if (!q2Source) throw new UnsolvableSheet(`Q2: no Period 2 record on hand for ${q2Name}`);
  const q2Quote = quoteFrom(q2Source);

  const q3Source = ctx.workByName?.[q3Name] ?? q2Source;
  const q3Quote = quoteFrom(q3Source, 14);

  // A quotation that is deliberately NOT in the named classmate's record, so the
  // platform's verbatim gate fires and the panel never reads Q2 at all.
  const q2Text = quality === "failing"
    ? `"a sentence this classmate never wrote anywhere in their work" — ${q2Name}. I think that shows something.`
    : `"${q2Quote}" — ${q2Name}. That line shows they lead with the concrete thing they actually do, which is why their work is easy to check.`;

  return {
    ordering,
    q2Name,
    q3Name,
    answers: {
      q1: q1List.join("\n"),
      q2: q2Text,
      q3: [
        `${q3Name}: the true good thing is how specific you are — "${q3Quote}".`,
        "A stranger could act on that without asking you anything.",
        "The honest hard thing: the caveat arrives after the answer, so a fast reader takes the answer and leaves the qualification behind. Put it first and the same sentence does twice the work.",
      ].join(" ").slice(0, 600),
      q4: quality === "failing"
        ? { a: "not-the-answer", b: "wrong", c: "0" }
        : solveQ4(sheet),
    },
  };
}

// ---------------------------------------------------------------- credentials
/** Mirrors src/lib/credentials.ts `canonicalize` — keys sorted at every depth. */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/**
 * Verify a diploma with raw node:crypto against the PUBLISHED key.
 *
 * Deliberately does not use the app's helper and does not trust the `valid`
 * field the API returns — the whole promise of the credential is that a
 * stranger can check it without trusting this server, so the harness checks it
 * the way a stranger would.
 */
export function verifyCredential(payload, signatureB64, publicKeyB64) {
  const key = createPublicKey({
    key: Buffer.from(publicKeyB64, "base64"),
    format: "der",
    type: "spki",
  });
  return cryptoVerify(
    null,
    Buffer.from(canonicalize(payload), "utf8"),
    key,
    Buffer.from(signatureB64, "base64"),
  );
}
