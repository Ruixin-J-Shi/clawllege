// Turn a region of the ink drawing into ONE filled silhouette path.
//
// The artwork is an outline-and-stipple drawing: its interior is transparent, so
// shrinking it just averages thin lines toward nothing (measured at item 7: ~23%
// coverage at 24px, ~16% binarised). A favicon needs mass, so we recover the
// body the outline encloses:
//
//   1 binarise the ink
//   2 morphological close, to seal the small breaks every pen drawing has —
//     without this the flood fill leaks through the outline and eats the body
//   3 flood fill from the border: whatever the fill cannot reach is interior
//   4 solid = interior + ink. The dactyl gap survives as negative space for free,
//     because it opens to the outside and the fill walks straight into it
//   5 keep the largest connected blob, trace its contour, simplify
import { readPNG, writePNG, crop, resize } from "./png.mjs";

export function binarise(img, threshold = 40) {
  const n = img.width * img.height;
  const on = new Uint8Array(n);
  for (let i = 0; i < n; i++) on[i] = img.data[i * 4 + 3] > threshold ? 1 : 0;
  return { w: img.width, h: img.height, on };
}

function dilate({ w, h, on }, r) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let hit = 0;
    for (let dy = -r; dy <= r && !hit; dy++) for (let dx = -r; dx <= r && !hit; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && on[ny * w + nx]) hit = 1;
    }
    out[y * w + x] = hit;
  }
  return { w, h, on: out };
}

function erode({ w, h, on }, r) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let all = 1;
    for (let dy = -r; dy <= r && all; dy++) for (let dx = -r; dx <= r && all; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !on[ny * w + nx]) all = 0;
    }
    out[y * w + x] = all;
  }
  return { w, h, on: out };
}

export const close = (m, r) => erode(dilate(m, r), r);
/** Opening: drops isolated stipple dots, keeps drawn strokes. */
export const open = (m, r) => dilate(erode(m, r), r);
export { dilate, erode };

/** a AND NOT b */
export function subtract(a, b) {
  const on = new Uint8Array(a.w * a.h);
  for (let i = 0; i < on.length; i++) on[i] = a.on[i] && !b.on[i] ? 1 : 0;
  return { w: a.w, h: a.h, on };
}

/**
 * Carve the drawing's INTERIOR strokes back out of a filled silhouette.
 *
 * In this illustration the claw is closed — the fingers meet along a drawn
 * line rather than leaving an open gap — so filling the outline swallows the
 * pincer entirely and the result reads as a bean. Cutting the interior strokes
 * back out restores the finger separation and the wrist joint band as negative
 * space. Strokes near the outer boundary are left alone so the silhouette's
 * edge is not eaten away.
 */
export function carveInteriorStrokes(solid, ink, { edgeKeep = 6, strokeR = 1, minStroke = 400, widen = 2 } = {}) {
  const strokes = open(ink, strokeR);
  const inner = erode(solid, edgeKeep);
  const interiorStrokes = { w: solid.w, h: solid.h, on: new Uint8Array(solid.w * solid.h) };
  for (let i = 0; i < interiorStrokes.on.length; i++) {
    interiorStrokes.on[i] = strokes.on[i] && inner.on[i] ? 1 : 0;
  }
  // Only the DRAWN structure earns negative space. Without a size filter the
  // stipple shading survives as hundreds of speckles, which is invisible at
  // favicon size but bloats the traced path enormously.
  const kept = componentsAtLeast(interiorStrokes, minStroke);
  return subtract(solid, widen > 0 ? dilate(kept, widen) : kept);
}

/** Keep only connected components of at least `minSize` pixels. */
export function componentsAtLeast({ w, h, on }, minSize) {
  const seen = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!on[s] || seen[s]) continue;
    const comp = [s]; seen[s] = 1; const stack = [s];
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (on[j] && !seen[j]) { seen[j] = 1; comp.push(j); stack.push(j); }
      }
    }
    if (comp.length >= minSize) for (const i of comp) out[i] = 1;
  }
  return { w, h, on: out };
}

/** Solid body = everything the flood fill from the border cannot reach. */
export function fillInterior({ w, h, on }) {
  const outside = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    const i = y * w + x;
    if (x < 0 || y < 0 || x >= w || y >= h || outside[i] || on[i]) return;
    outside[i] = 1; stack.push(i);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i - x) / w;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = outside[i] ? 0 : 1;
  return { w, h, on: solid };
}

/** Largest 4-connected component — drops stray specks and stipple islands. */
export function largestBlob({ w, h, on }) {
  const label = new Int32Array(w * h).fill(-1);
  let best = -1, bestSize = 0, cur = 0;
  for (let s = 0; s < w * h; s++) {
    if (!on[s] || label[s] !== -1) continue;
    let size = 0; const stack = [s]; label[s] = cur;
    while (stack.length) {
      const i = stack.pop(); size++;
      const x = i % w, y = (i - x) / w;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (on[j] && label[j] === -1) { label[j] = cur; stack.push(j); }
      }
    }
    if (size > bestSize) { bestSize = size; best = cur; }
    cur++;
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = label[i] === best ? 1 : 0;
  return { m: { w, h, on: out }, size: bestSize };
}

/**
 * Moore-neighbour boundary trace with an explicit backtrack direction.
 *
 * The naive version — "search the 8 neighbours starting a couple of steps back"
 * — terminates after four points, because without tracking which neighbour you
 * arrived from you immediately walk back the way you came.
 */
export function traceContour({ w, h, on }) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? on[y * w + x] : 0);
  // clockwise from East
  const N = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  let sx = -1, sy = -1;
  outer: for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (at(x, y)) { sx = x; sy = y; break outer; }
  if (sx < 0) return [];

  const pts = [[sx, sy]];
  let px = sx, py = sy;
  let from = 4; // we scanned left-to-right, so the pixel to the West is background
  const limit = 8 * w * h;
  for (let step = 0; step < limit; step++) {
    let found = -1;
    for (let k = 1; k <= 8; k++) {
      const d = (from + k) % 8;
      const nx = px + N[d][0], ny = py + N[d][1];
      if (at(nx, ny)) { found = d; px = nx; py = ny; break; }
    }
    if (found < 0) break;                 // isolated pixel
    from = (found + 4) % 8;               // where we came from, seen from the new pixel
    if (px === sx && py === sy) break;    // closed the loop
    pts.push([px, py]);
  }
  return pts;
}

/** Douglas-Peucker. */
export function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const d2 = (p, a, b) => {
    const [x, y] = p, [x1, y1] = a, [x2, y2] = b;
    const dx = x2 - x1, dy = y2 - y1;
    if (dx === 0 && dy === 0) return (x - x1) ** 2 + (y - y1) ** 2;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
    return (x - (x1 + t * dx)) ** 2 + (y - (y1 + t * dy)) ** 2;
  };
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = d2(pts[i], pts[a], pts[b]);
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > eps * eps) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Closed path with quadratic smoothing through midpoints — no polygon facets. */
export function toPath(pts, scale = 1, ox = 0, oy = 0, dp = 2) {
  const P = pts.map(([x, y]) => [(x - ox) * scale, (y - oy) * scale]);
  const f = (v) => Number(v.toFixed(dp));
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let d = `M${f(mid(P[P.length - 1], P[0])[0])} ${f(mid(P[P.length - 1], P[0])[1])}`;
  for (let i = 0; i < P.length; i++) {
    const cpt = P[i], nxt = P[(i + 1) % P.length], m = mid(cpt, nxt);
    d += `Q${f(cpt[0])} ${f(cpt[1])} ${f(m[0])} ${f(m[1])}`;
  }
  return d + "Z";
}

export { crop, resize, readPNG, writePNG };

/**
 * The whole pipeline: master artwork -> one filled path for the crusher claw.
 * Returns { d, w, h } where the path is scaled so its long side is 100.
 */
export function traceCrusherClaw(masterPath, {
  work = 520, threshold = 40, closeR = 2, edgeKeep = 7,
  minStroke = 900, widen = 3, eps = 4,
} = {}) {
  const master = readPNG(masterPath);
  const k = master.height / 1024;                       // master maps onto the 640x1024 proof
  const region = crop(master, Math.round(20 * k), 0, Math.round(268 * k), Math.round(400 * k));
  const small = resize(region, work, Math.round((work * region.height) / region.width));

  const bin = binarise(small, threshold);
  // Pad so the fill has an outside to start from, and seal the bottom edge: the
  // crop cuts the arm, and without the seal the fill walks in through the wrist
  // and eats the whole body.
  const PAD = 12, W = bin.w + 2 * PAD, H = bin.h + 2 * PAD;
  const on = new Uint8Array(W * H);
  for (let y = 0; y < bin.h; y++) for (let x = 0; x < bin.w; x++) on[(y + PAD) * W + x + PAD] = bin.on[y * bin.w + x];
  const ink = { w: W, h: H, on: Uint8Array.from(on) };
  const sealRow = H - PAD - 1;
  for (let x = 0; x < W; x++) { on[sealRow * W + x] = 1; on[(sealRow - 1) * W + x] = 1; }

  const solid = fillInterior(close({ w: W, h: H, on }, closeR));
  // Drop the seal again, or it welds every bottom-touching part into one blob.
  for (let x = 0; x < W; x++) for (let y = sealRow - 1; y < H; y++) solid.on[y * W + x] = 0;

  const { m: body } = largestBlob(solid);
  const carved = carveInteriorStrokes(body, ink, { edgeKeep, strokeR: 1, minStroke, widen });
  const { m: fin } = largestBlob(carved);

  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (fin.on[y * W + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const pts = simplify(traceContour(fin), eps);
  const scale = 100 / Math.max(bw, bh);
  return { d: toPath(pts, scale, x0, y0, 2), w: bw * scale, h: bh * scale, points: pts.length,
           mask: fin, bbox: { x: x0, y: y0, w: bw, h: bh } };
}
