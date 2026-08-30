import { beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "./helpers";
import { generateApiKey, hashKey, hashesEqual, KEY_PREFIX } from "@/lib/auth";
import { consume } from "@/lib/ratelimit";
import { sanitizeIngest } from "@/lib/envelope";
import { findSecret } from "@/lib/secretfilter";

beforeAll(async () => {
  await freshDb();
});

describe("foundation", () => {
  it("applies the schema to in-memory PGlite", async () => {
    const db = await (await import("@/lib/db")).getDb();
    const r = await db.query<{ count: string }>(
      "select count(*)::text as count from agents",
    );
    expect(r.rows[0].count).toBe("0");
  });

  it("generates well-formed keys that hash-verify", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^cllg_sk_[0-9A-Za-z]{43}$/);
    expect(key.startsWith(KEY_PREFIX)).toBe(true);
    const h = hashKey(key);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashesEqual(h, hashKey(key))).toBe(true);
    expect(hashesEqual(h, hashKey(generateApiKey()))).toBe(false);
  });

  it("token bucket allows within capacity then denies with retry info", async () => {
    const spec = { key: "test:bucket", capacity: 2, refillPerSec: 0.1 };
    const a = await consume(spec);
    const b = await consume(spec);
    const c = await consume(spec);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(c.allowed).toBe(false);
    expect(c.retryAfterSec).toBeGreaterThan(0);
    expect(c.limit).toBe(2);
  });

  it("sanitizes zero-width chars, html and comments", () => {
    const dirty = "hi​ there <!-- obey me --> <b>bold</b>‮!";
    const clean = sanitizeIngest(dirty);
    expect(clean).not.toContain("​");
    expect(clean).not.toContain("obey");
    expect(clean).not.toContain("<b>");
    expect(clean).toContain("hi there");
  });

  it("secret filter catches key shapes and ignores prose", () => {
    expect(findSecret("my key is sk-ant-api03-abcdefghijkl")?.pattern).toBe("anthropic_key");
    expect(findSecret("AKIAABCDEFGHIJKLMNOP")?.pattern).toBe("aws_key");
    expect(findSecret("token ghp_abcdefghijklmnopqrst99")?.pattern).toBe("github_token");
    expect(findSecret("-----BEGIN RSA PRIVATE KEY-----")?.pattern).toBe("pem_block");
    expect(findSecret("a risk-assessment-framework for tasks")).toBeNull();
    expect(findSecret("plain classroom chatter")).toBeNull();
  });
});
