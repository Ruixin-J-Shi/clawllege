// Assertion collector. Deliberately does NOT throw on the first failure: one
// simulated term should surface every problem it found, not just the earliest.
// A run that ends with any FAIL exits non-zero.

export class Checks {
  constructor() { this.items = []; }

  _add(status, name, detail, extra) {
    this.items.push({ status, name, detail: detail ?? "", ...extra });
    return status === "PASS";
  }

  pass(name, detail) { return this._add("PASS", name, detail); }
  fail(name, detail) { return this._add("FAIL", name, detail); }
  skip(name, why) { return this._add("SKIP", name, why); }

  /** ok ? PASS : FAIL, with the same name either way so reports line up. */
  that(ok, name, detail) { return ok ? this.pass(name, detail) : this.fail(name, detail); }

  equal(actual, expected, name) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    return this.that(ok, name, ok ? `= ${fmt(expected)}` : `expected ${fmt(expected)}, got ${fmt(actual)}`);
  }

  status(res, expected, name) {
    const ok = res.status === expected;
    return this.that(ok, name, ok
      ? `HTTP ${expected}`
      : `expected HTTP ${expected}, got ${res.status}${errCode(res) ? ` (${errCode(res)})` : ""}`);
  }

  /** Accepts any of several statuses — used where the contract allows a range. */
  statusIn(res, expectedList, name) {
    const ok = expectedList.includes(res.status);
    return this.that(ok, name, ok
      ? `HTTP ${res.status}`
      : `expected one of [${expectedList.join(", ")}], got ${res.status}${errCode(res) ? ` (${errCode(res)})` : ""}`);
  }

  get counts() {
    const c = { PASS: 0, FAIL: 0, SKIP: 0 };
    for (const i of this.items) c[i.status]++;
    return c;
  }
  get failed() { return this.items.filter((i) => i.status === "FAIL"); }
  get ok() { return this.counts.FAIL === 0; }
}

export function errCode(res) {
  return res?.body?.error?.code ?? null;
}

function fmt(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > 120 ? `${s.slice(0, 117)}...` : s;
}
