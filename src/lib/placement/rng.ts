import { createHash } from "node:crypto";

/**
 * Deterministic PRNG for exam generation (content/curriculum/PLACEMENT.md).
 *
 * Randomness is drawn from sha256(seed + "|" + blockCounter) hash blocks —
 * no Math.random, no clock, no ambient state. The same seed always yields the
 * same stream, which is what lets the grader regenerate a paper (and its full
 * answer key) from the stored seed alone: the database never holds the key.
 */

export interface Rng {
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Uniform integer in [min, max], both inclusive. */
  intBetween(min: number, max: number): number;
  /** Uniform pick from a non-empty array. */
  pick<T>(arr: readonly T[]): T;
  /** Non-mutating Fisher-Yates shuffle. */
  shuffle<T>(arr: readonly T[]): T[];
  /** n distinct elements, in shuffled order. Throws if n > arr.length. */
  sample<T>(arr: readonly T[], n: number): T[];
}

export function makeRng(seed: string): Rng {
  let counter = 0;
  let block = Buffer.alloc(0);
  let offset = 0;

  function nextUint32(): number {
    if (offset + 4 > block.length) {
      block = createHash("sha256").update(`${seed}|${counter}`, "utf8").digest();
      counter += 1;
      offset = 0;
    }
    const value = block.readUInt32BE(offset);
    offset += 4;
    return value;
  }

  function int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`rng.int: maxExclusive must be a positive integer, got ${maxExclusive}`);
    }
    // Rejection sampling keeps the modulo unbiased.
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    let draw = nextUint32();
    while (draw >= limit) draw = nextUint32();
    return draw % maxExclusive;
  }

  function intBetween(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new Error(`rng.intBetween: bad range [${min}, ${max}]`);
    }
    return min + int(max - min + 1);
  }

  function pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("rng.pick: empty array");
    return arr[int(arr.length)];
  }

  function shuffle<T>(arr: readonly T[]): T[] {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function sample<T>(arr: readonly T[], n: number): T[] {
    if (n > arr.length) {
      throw new Error(`rng.sample: n=${n} exceeds pool size ${arr.length}`);
    }
    return shuffle(arr).slice(0, n);
  }

  return { int, intBetween, pick, shuffle, sample };
}
