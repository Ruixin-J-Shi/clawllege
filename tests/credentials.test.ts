import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalize,
  generateSigningKey,
  publicIdFor,
  publicKeyB64,
  signPayload,
  signingKeyAvailable,
  verifyPayload,
} from "@/lib/credentials";

/** Signing is the product's integrity core: an outside auditor must be able to
 *  check a diploma without trusting this server at all. */

let keys: { privateKey: string; publicKey: string };
const originalKey = process.env.CREDENTIAL_SIGNING_KEY;

beforeAll(() => {
  keys = generateSigningKey();
  process.env.CREDENTIAL_SIGNING_KEY = keys.privateKey;
});

afterEach(() => {
  process.env.CREDENTIAL_SIGNING_KEY = keys.privateKey;
});

const payload = {
  public_id: "CLLG-F26-ES-7K2Q",
  agent_name: "pinchy",
  level: "elementary_school" as const,
  track: "standard" as const,
  term: "fall-26-es",
  cohort: "Shallows 1",
  issued_at: "2026-09-20T00:00:00.000Z",
  transcript: {
    periods_completed: 6,
    attendance: { journals: 6, submissions: 6, required: 5 },
    mastery: { "self-introduction": 66.67, "name-accuracy": 40 },
    peer_review_standing: 0.83,
    exam: { total: 13, passed: true },
  },
};

describe("canonicalize", () => {
  it("sorts object keys at every depth and emits no whitespace", () => {
    const out = canonicalize({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } });
    expect(out).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
    expect(out).not.toMatch(/\s/);
  });

  it("preserves array order — order is meaningful, key order is not", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalize({ x: [1, 2] })).not.toBe(canonicalize({ x: [2, 1] }));
  });

  it("is identical for documents that differ only in key order", () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    expect(canonicalize(reordered)).toBe(canonicalize(payload));
  });

  it("handles primitives and null", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize("x")).toBe('"x"');
    expect(canonicalize(true)).toBe("true");
  });
});

describe("signing", () => {
  it("signs and verifies with the published key", () => {
    const sig = signPayload(payload);
    expect(verifyPayload(payload, sig)).toBe(true);
    expect(verifyPayload(payload, sig, publicKeyB64())).toBe(true);
    expect(publicKeyB64()).toBe(keys.publicKey);
  });

  it("detects tampering anywhere in the document", () => {
    const sig = signPayload(payload);
    expect(verifyPayload({ ...payload, agent_name: "notpinchy" }, sig, keys.publicKey)).toBe(false);
    expect(verifyPayload({ ...payload, level: "college" }, sig, keys.publicKey)).toBe(false);
    expect(
      verifyPayload(
        { ...payload, transcript: { ...payload.transcript, exam: { total: 16, passed: true } } },
        sig,
        keys.publicKey,
      ),
    ).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const sig = signPayload(payload);
    const other = generateSigningKey();
    expect(verifyPayload(payload, sig, other.publicKey)).toBe(false);
  });

  it("rejects a garbage signature without throwing", () => {
    expect(verifyPayload(payload, "not-base64-at-all!!", keys.publicKey)).toBe(false);
    expect(verifyPayload(payload, "", keys.publicKey)).toBe(false);
  });

  it("refuses to sign when no key is configured", () => {
    delete process.env.CREDENTIAL_SIGNING_KEY;
    expect(signingKeyAvailable()).toBe(false);
    expect(() => signPayload(payload)).toThrow(/CREDENTIAL_SIGNING_KEY is not set/);
  });

  it("rejects a malformed key rather than signing with a silent default", () => {
    process.env.CREDENTIAL_SIGNING_KEY = "bm90LWEta2V5";
    expect(signingKeyAvailable()).toBe(false);
    expect(() => signPayload(payload)).toThrow(/not a base64 PKCS#8/);
  });
});

describe("public_id", () => {
  it("follows CLLG-<TERM><YY>-<LEVEL>-<4 base32>", () => {
    for (const [slug, level, prefix] of [
      ["fall-26-es", "elementary_school", "CLLG-F26-ES-"],
      ["fall-26-ms", "middle_school", "CLLG-F26-MS-"],
      ["spring-27-hs", "high_school", "CLLG-S27-HS-"],
      ["fall-26-col", "college", "CLLG-F26-COL-"],
    ] as const) {
      const id = publicIdFor(slug, level);
      expect(id.startsWith(prefix)).toBe(true);
      expect(id.slice(prefix.length)).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  it("avoids ambiguous characters in the random suffix", () => {
    const suffixes = Array.from({ length: 200 }, () => publicIdFor("fall-26-es", "elementary_school").split("-").pop()!);
    expect(suffixes.join("")).not.toMatch(/[ILOU]/);
    // And it is actually random.
    expect(new Set(suffixes).size).toBeGreaterThan(50);
  });

  it("degrades sanely on an unusual term slug", () => {
    expect(publicIdFor("weird", "college").startsWith("CLLG-WEI-COL-")).toBe(true);
  });
});
