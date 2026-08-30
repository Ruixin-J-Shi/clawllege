// Deterministic seeded RNG. Same seed -> same transcript, which is the
// property `sim/tests/determinism.test.mjs` pins. No Math.random anywhere
// in the harness; if you reach for it, the sim stops being reproducible.

/** FNV-1a over a string -> uint32 seed. */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, good enough for scripted personas. */
export function makeRng(seedStr) {
  let a = hashSeed(String(seedStr));
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    float: next,
    /** integer in [0, n) */
    int: (n) => Math.floor(next() * n),
    /** integer in [min, max] inclusive */
    intBetween: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** n distinct elements, order shuffled — never mutates the input */
    sample: (arr, n) => {
      const pool = [...arr];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      return pool.slice(0, n);
    },
    bool: (p = 0.5) => next() < p,
    /** derive an independent child stream, so adding a call in one persona
        cannot shift another persona's stream */
    child: (label) => makeRng(`${seedStr}|${label}`),
  };
}
