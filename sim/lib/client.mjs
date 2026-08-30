// HTTP client for the simulated cohort. Pure transport: the sim only ever
// talks to the platform the way a real visiting agent would — over HTTP, with
// a bearer key, obeying rate limits.
//
// SAFETY: this harness writes a full term of data (agents, keys, enrolments,
// hallway traffic). `.env.local` in this repo carries live Supabase creds, and
// `DATABASE_URL` there has been commented out but could come back at any time.
// So the client refuses outright to talk to any host that is not loopback.
// Point it at a deployed Clawllege and it stops before the first request.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

export class RemoteTargetRefused extends Error {}

export function assertLocalTarget(baseUrl) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new RemoteTargetRefused(`--base-url is not a URL: ${baseUrl}`);
  }
  if (!LOOPBACK.has(u.hostname)) {
    throw new RemoteTargetRefused(
      `refusing to run against non-loopback host "${u.hostname}".\n` +
        `  The simulator creates agents, API keys and enrolments. It must never point at a\n` +
        `  deployed environment. Start a local server and pass --base-url http://127.0.0.1:3333`,
    );
  }
  return u.origin;
}

export class Client {
  /**
   * @param {{baseUrl:string, transcript?:Array, label?:string, identity?:{ip:string, ua:string}}} opts
   *
   * `identity` simulates the machine this agent runs on. It matters: the
   * platform derives its per-IP registration bucket from x-forwarded-for and
   * its exam sitting fingerprint from sha256(ip|user-agent). A cohort of ten
   * agents is ten different humans on ten different machines, so the sim must
   * present ten client identities — driving all of them from one identity
   * throttles at agent 2 and measures nothing but the throttle.
   */
  constructor({ baseUrl, transcript = [], label = "anon", identity = null }) {
    this.origin = assertLocalTarget(baseUrl);
    this.transcript = transcript;
    this.label = label;
    this.identity = identity;
    this.apiKey = null;
    this.calls = 0;
    this.rateLimitWaits = 0;
  }

  withKey(apiKey) {
    this.apiKey = apiKey;
    return this;
  }

  /**
   * One HTTP call. Never throws on a non-2xx — the sim asserts on status codes
   * (the abuse agent *expects* 404s and 422s), so a throw would hide the finding.
   * Retries only on 429, honouring Retry-After, at most `maxRetries` times.
   */
  async request(method, path, { body, key, expectStatus, maxRetries = 4, noRetry = false } = {}) {
    if (noRetry) maxRetries = 0;
    const url = `${this.origin}${path}`;
    const headers = { accept: "application/json" };
    if (this.identity) {
      headers["x-forwarded-for"] = this.identity.ip;
      headers["user-agent"] = this.identity.ua;
    }
    const authKey = key ?? this.apiKey;
    if (authKey) headers.authorization = `Bearer ${authKey}`;
    if (body !== undefined) headers["content-type"] = "application/json";

    let attempt = 0;
    for (;;) {
      const started = Date.now();
      let res, text;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        text = await res.text();
      } catch (err) {
        const entry = {
          agent: this.label, method, path, status: 0,
          ms: Date.now() - started, error: String(err?.message ?? err),
        };
        this.transcript.push(entry);
        throw new Error(`${method} ${path} — transport failure: ${entry.error}`);
      }
      this.calls++;

      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }

      const entry = {
        agent: this.label,
        method,
        path,
        status: res.status,
        ms: Date.now() - started,
        request: body ?? null,
        response: json ?? text.slice(0, 400),
        rate: {
          limit: res.headers.get("x-ratelimit-limit"),
          remaining: res.headers.get("x-ratelimit-remaining"),
          retryAfter: res.headers.get("retry-after"),
        },
      };
      this.transcript.push(entry);

      if (res.status === 429 && attempt < maxRetries) {
        attempt++;
        this.rateLimitWaits++;
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000 + 250, 25_000)
          : Math.min(500 * 2 ** attempt, 8_000);
        entry.retriedAfterMs = waitMs;
        await sleep(waitMs);
        continue;
      }

      const result = { status: res.status, body: json, raw: text, headers: res.headers };
      if (expectStatus !== undefined && res.status !== expectStatus) {
        result.unexpected = `expected ${expectStatus}, got ${res.status}`;
      }
      return result;
    }
  }

  get(path, opts) { return this.request("GET", path, opts); }
  post(path, body, opts) { return this.request("POST", path, { ...opts, body }); }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until the server answers /api/health, or give up. */
export async function waitForServer(baseUrl, timeoutMs = 60_000) {
  const origin = assertLocalTarget(baseUrl);
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/api/health`);
      if (res.ok) return true;
      lastErr = `health returned ${res.status}`;
    } catch (e) {
      lastErr = String(e?.message ?? e);
    }
    await sleep(500);
  }
  throw new Error(`server at ${origin} not healthy after ${timeoutMs}ms — last: ${lastErr}`);
}
