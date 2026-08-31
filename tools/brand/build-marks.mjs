#!/usr/bin/env node
// Regenerates every derived brand asset from the human's master artwork.
//
//   node tools/brand/build-marks.mjs
//
// The mark is the human's ink-stipple lobster. This script only derives from it
// — it never redraws it. Outputs:
//   public/brand/lobster-{512,256,128}.png        Fathom Ink, for light grounds
//   public/brand/lobster-gold-{256,128}.png       Drawn-Butter Gold, for the crimson seal
//   public/brand/crest.svg, seal.svg              self-contained (raster embedded)
//   src/app/icon.svg                              favicon: the SVG pincer, not the lobster
//
// WHY THE FAVICON IS NOT THE LOBSTER. The brief asked for a left-claw crop at
// small sizes. Measured, that crop fails: the artwork is outline-and-stipple with
// a transparent interior, so shrinking averages thin ink toward nothing (24px
// ink coverage ~23% at very low alpha; binarised first, ~16% and hollow). No crop
// fixes it — it is the medium, not the framing. So small marks use the vector
// pincer below, which is the fallback the master pre-authorised.
import { readPNG, writePNG, resize, encodeICO } from "./png.mjs";
import { traceCrusherClaw } from "./trace.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root derived from this script's location (tools/brand/ -> two up),
// so the generator runs from any cwd; argv[2] still overrides for testing.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ?? path.join(here, "..", "..");
const P = (...p) => path.join(root, ...p);

// ------------------------------------------------------------------ the favicon
// The small mark is a filled TRACE of the crusher claw in the human's own
// drawing — not generic claw geometry. The artwork's interior is transparent,
// so the trace recovers the body its outline encloses and cuts the drawn
// interior strokes back out, which is what keeps the finger separation and the
// wrist joint reading as negative space. See tools/brand/trace.mjs.
// Master artwork lives beside the tools so the repo regenerates its own marks.
const CLAW = traceCrusherClaw(path.join(here, "assets", "lobster-master-transparent.png"));

const SHIELD = "M75 10 L131 26 V84 C131 122 106 148 75 162 C44 148 19 122 19 84 V26 Z";

// Placement of the charge on the shield. Single source — every copy of the crest
// derives from these numbers.
//
// The chief's bottom edge is y=46 and the wave crests reach y~=121. The first
// placement (y=41, h=94) pushed the claw tips up onto the crimson band, where
// ink-on-crimson muddies — the same near-zero contrast that made the seal read as
// an empty ring. The charge now starts at y=50, leaving 4 units of clear
// parchment under the chief, and the lobster's BODY finishes above the waterline;
// only the long tail antennae reach past it, with the waves drawn behind them.
const CHARGE = { x: 41.25, y: 50, w: 67.5, h: 108 };

// Bezants. The chief is clipped by the shield's sloped top, so the usable span
// is narrower than the chief rectangle suggests: at y=22 (the top of a bezant)
// the shield runs x=33..117, leaving centres valid only within 39..111. The
// first spacing put the outer dots at 43 and 106 — about 4 units of slack — and
// they read as pushed against the edge. Pulled in and slightly reduced.
const BEZANTS = { cx: [49.5, 66.5, 83.5, 100.5], cy: 28, r: 5.5 };
const b64 = (p) => readFileSync(p).toString("base64");

// ------------------------------------------------------------- raster derivatives
// `lobster.png` (hero) and `lobster-512.png` are the master's prepared assets and
// are READ ONLY here — this script derives from them and must never overwrite
// them. It did once; the 512 was restored from git.
const master = readPNG(P("public/brand/lobster.png"));
for (const w of [256, 128]) {
  const h = Math.round((w * master.height) / master.width);
  writePNG(P(`public/brand/lobster-${w}.png`), resize(master, w, h));
}
const gold = (img) => {
  const g = { width: img.width, height: img.height, data: Buffer.from(img.data) };
  for (let i = 0; i < g.data.length; i += 4) { g.data[i] = 0xc9; g.data[i + 1] = 0xa2; g.data[i + 2] = 0x27; }
  return g;
};
// Fathom Ink on Carapace Crimson is almost no contrast — the seal read as empty
// until the charge was repainted gold.
for (const w of [256, 128]) {
  const src = readPNG(P(`public/brand/lobster-${w}.png`));
  writePNG(P(`public/brand/lobster-gold-${w}.png`), gold(src));
}

// ------------------------------------------------------------------- the marks
const inkHref  = `data:image/png;base64,${b64(P("public/brand/lobster-128.png"))}`;
const goldHref = `data:image/png;base64,${b64(P("public/brand/lobster-gold-128.png"))}`;

const crest = (href) => `<svg viewBox="0 0 150 184" role="img" aria-label="Clawllege crest" xmlns="http://www.w3.org/2000/svg">
  <defs><clipPath id="cwShield"><path d="${SHIELD}"/></clipPath></defs>
  <path d="${SHIELD}" fill="#FDF9F0"/>
  <g clip-path="url(#cwShield)">
    <rect x="10" y="10" width="130" height="36" fill="#9E2B25"/>
    <g fill="#C9A227">
      ${BEZANTS.cx.map((cx) => `<circle cx="${cx}" cy="${BEZANTS.cy}" r="${BEZANTS.r}"/>`).join("")}
    </g>
    <g stroke="#14303E" stroke-width="4" fill="none" stroke-linecap="round">
      <path d="M22 130 q 10 -9 20 0 t 20 0 t 20 0 t 20 0 t 20 0"/>
      <path d="M22 144 q 10 -9 20 0 t 20 0 t 20 0 t 20 0 t 20 0" opacity="0.55"/>
    </g>
    <image href="${href}" x="${CHARGE.x}" y="${CHARGE.y}" width="${CHARGE.w}" height="${CHARGE.h}" preserveAspectRatio="xMidYMid meet"/>
  </g>
  <path d="${SHIELD}" fill="none" stroke="#C9A227" stroke-width="4"/>
  <path d="M15 160 h120 l-7 10 7 10 H15 l7 -10 Z" fill="#9E2B25"/>
  <text x="75" y="173.5" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="8" letter-spacing="1" fill="#FDF9F0">EXUO ERGO CRESCO</text>
</svg>`;

const seal = (href) => `<svg viewBox="0 0 120 120" role="img" aria-label="Seal of Clawllege" xmlns="http://www.w3.org/2000/svg">
  <circle cx="60" cy="60" r="57" fill="#9E2B25"/>
  <circle cx="60" cy="60" r="51" fill="none" stroke="#C9A227" stroke-width="1.5"/>
  <circle cx="60" cy="60" r="34" fill="none" stroke="#C9A227" stroke-width="1"/>
  <defs><path id="cwSealArc" d="M60 60 m -42.5 0 a 42.5 42.5 0 1 1 85 0 a 42.5 42.5 0 1 1 -85 0"/></defs>
  <text font-size="8" letter-spacing="1.6" fill="#F6EFE3" font-family="Georgia, 'Times New Roman', serif">
    <textPath href="#cwSealArc">SIGILLUM · CLAWLLEGII · EST · MMXXVI · </textPath>
  </text>
  <image href="${href}" x="38" y="26" width="44" height="66" preserveAspectRatio="xMidYMid meet"/>
  <g fill="#C9A227">
    <circle cx="42" cy="90" r="2.6"/><circle cx="54" cy="92" r="2.6"/>
    <circle cx="66" cy="92" r="2.6"/><circle cx="78" cy="90" r="2.6"/>
  </g>
</svg>`;

writeFileSync(P("public/brand/crest.svg"), crest(inkHref) + "\n");
writeFileSync(P("public/brand/seal.svg"), seal(goldHref) + "\n");

// Favicon. Carapace Crimson holds up on light grounds; on a dark tab strip it
// goes muddy against Fathom, so the SVG carries a colour-scheme rule and turns
// Drawn-Butter Gold there. Measured both ways at 16/24/48 before choosing.
writeFileSync(P("src/app/icon.svg"),
`<svg viewBox="0 0 ${CLAW.w.toFixed(2)} ${CLAW.h.toFixed(2)}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Clawllege">
  <style>
    path { fill: #9E2B25 }
    @media (prefers-color-scheme: dark) { path { fill: #C9A227 } }
  </style>
  <path d="${CLAW.d}"/>
</svg>
`);
console.log("favicon: traced claw, " + CLAW.points + " points, viewBox " + CLAW.w.toFixed(1) + "x" + CLAW.h.toFixed(1));

// favicon.ico — still create-next-app's default until now, which many browsers
// (and Safari, with no SVG-favicon support) would have preferred over icon.svg,
// leaving the Next.js logo in the tab. Rasterised from the traced MASK rather
// than the path, so no bezier renderer is needed.
const { mask, bbox } = CLAW;
function rasterise(size, [r, g, b]) {
  const data = Buffer.alloc(size * size * 4);
  const scale = Math.max(bbox.w, bbox.h) / size;      // fit the long side
  const offX = bbox.x + bbox.w / 2, offY = bbox.y + bbox.h / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // supersample 3x3 for a clean edge at 16px
    let hit = 0;
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
      const mx = Math.round(offX + ((x + (sx + 0.5) / 3) - size / 2) * scale);
      const my = Math.round(offY + ((y + (sy + 0.5) / 3) - size / 2) * scale);
      if (mx >= 0 && my >= 0 && mx < mask.w && my < mask.h && mask.on[my * mask.w + mx]) hit++;
    }
    const i = (y * size + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = Math.round((hit / 9) * 255);
  }
  return { width: size, height: size, data };
}
const CRIMSON = [0x9e, 0x2b, 0x25];
writeFileSync(P("src/app/favicon.ico"), encodeICO([16, 32, 48, 128].map((n) => rasterise(n, CRIMSON))));
console.log("favicon.ico: rewritten from the traced claw (16/32/48/128)");
console.log("brand marks rebuilt");
