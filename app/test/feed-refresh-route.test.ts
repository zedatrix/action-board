import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPrFeed, type Gh, type PrFeedSource, type RefreshResult } from "../server/feed";
import { FEED_REFRESH_ROUTE, feedRefreshHandler } from "../vite.config";

// POST /__ab/feed/refresh on a plain HTTP server, in front of a PR feed with a fake gh (no network) and a fake clock.
let http: Server;
let base: string;
let feed: PrFeedSource | undefined;
let t = Date.parse("2026-11-26T15:00:00.000Z");
let calls = 0;
let release: (() => void) | undefined;
let remaining = 4000;

const page = () =>
  JSON.stringify({
    data: {
      viewer: { login: "user" },
      rateLimit: { cost: 5, remaining, limit: 5000, resetAt: "2026-11-26T16:00:00Z" },
      search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    },
  });
const gh: Gh = () => {
  calls++;
  return new Promise((resolve) => (release = () => resolve(page())));
};
const settle = async () => {
  release?.();
  release = undefined;
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeAll(async () => {
  const handler = feedRefreshHandler({ refresh: () => feed!.refresh() });
  http = createServer((req, res) => (req.url === FEED_REFRESH_ROUTE ? void handler(req, res) : res.end()));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => http.close(() => resolve())));
afterEach(async () => {
  await settle();
  feed?.close();
  feed = undefined;
  calls = 0;
  remaining = 4000;
});

const newFeed = () => (feed = createPrFeed({ repos: ["acme/example-api"], gh, now: () => new Date(t), log: () => {} }));

const post = (opts: { body?: string; headers?: Record<string, string>; method?: string } = {}) =>
  fetch(`${base}${FEED_REFRESH_ROUTE}`, { method: opts.method ?? "POST", headers: opts.headers, body: opts.body }).then(async (r) => ({
    status: r.status,
    cache: r.headers.get("cache-control"),
    body: JSON.parse(await r.text()) as { ok: boolean } & Partial<RefreshResult>,
  }));
const raw = (host: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request(`${base}${FEED_REFRESH_ROUTE}`, { method: "POST", agent: false, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });

describe("POST /__ab/feed/refresh", () => {
  it("answers off while the feed is not started, then starts a run, skips it in flight and within 60 s of the last start", async () => {
    expect(FEED_REFRESH_ROUTE).toBe("/__ab/feed/refresh");
    newFeed();
    expect(await post()).toEqual({ status: 200, cache: "no-store", body: { ok: true, started: false, reason: "off" } });
    feed!.start(3_600_000);
    expect(calls).toBe(1);
    expect((await post()).body).toEqual({ ok: true, started: false, reason: "in-flight" });
    await settle();
    t += 30_000;
    expect((await post()).body).toEqual({ ok: true, started: false, reason: "debounced" });
    t += 30_000;
    // An empty body or a small JSON one, with or without a JSON content type.
    expect((await post({ body: "{}", headers: { "Content-Type": "application/json" } })).body).toEqual({ ok: true, started: true });
    expect(calls).toBe(2);
    expect((await post({ headers: { Origin: "http://board.localhost:8085" } })).body).toEqual({ ok: true, started: false, reason: "in-flight" });
  });

  it("answers quota when the quota guard says to wait", async () => {
    remaining = 400;
    newFeed();
    feed!.start(3_600_000);
    await settle();
    t += 10 * 60_000;
    expect((await post()).body).toEqual({ ok: true, started: false, reason: "quota" });
    expect(calls).toBe(1);
  });

  it("refuses other methods (405), foreign hosts and origins (403), non-JSON (415) and bad or big bodies (400), starting nothing", async () => {
    newFeed();
    feed!.start(3_600_000);
    await settle();
    t += 120_000;
    const no = { ok: false };
    expect(await post({ method: "GET" })).toMatchObject({ status: 405, body: no });
    expect(await raw("evil.example:8085")).toBe(403);
    expect(await raw("board.localhost.evil.example")).toBe(403);
    for (const origin of ["https://evil.example", "http://board.localhost.evil.example:8085", "null"]) expect(await post({ headers: { Origin: origin } })).toMatchObject({ status: 403, body: no });
    expect(await post({ headers: { "Content-Type": "text/plain" }, body: "{}" })).toMatchObject({ status: 415, body: no });
    expect(await post({ headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "a=1" })).toMatchObject({ status: 415, body: no });
    expect(await post({ headers: { "Content-Type": "application/json" }, body: "{nope" })).toMatchObject({ status: 400, body: no });
    const big = await post({ headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(1024) }) }).catch(() => ({ status: 400, body: no }));
    expect(big).toMatchObject({ status: 400 });
    expect(calls).toBe(1);
    expect((await post()).body).toEqual({ ok: true, started: true });
    expect(calls).toBe(2);
  });
});
