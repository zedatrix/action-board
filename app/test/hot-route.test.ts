import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Board, HotMark } from "../src/data/types";
import { EVENTS_ROUTE, HOT_BY, HOT_LOG_ROUTE, HOT_ROUTE, hotLogRoute, hotRoute, type HotEvent } from "../vite.config";

// POST /__ab/hot and GET /__ab/hot-log on a dev server whose root is a temp dir: its src/data/board.ts is a temp board,
// AB_EVENTS_FILE a temp event log, and AB_BIN the real bin/ab.mjs. The real board.ts is only read, for its wrapper text.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const A = "/* BOARD-JSON-START */";
const Z = "/* BOARD-JSON-END */";
const original = readFileSync(join(ROOT, "app/src/data/board.ts"), "utf8");

const PR = "https://github.com/acme/example-api/pull/11764";
const FEED_ONLY = "https://github.com/acme/example-web/pull/11900";
const mine = { title: "Analytics for The dashboard", who: "Bob's re-review", link: PR };

let root: string;
let file: string;
let events: string;
let http: Server;
let base: string;
let close: () => Promise<void>;
const saved = { AB_BIN: process.env.AB_BIN, AB_EVENTS_FILE: process.env.AB_EVENTS_FILE };

const seed = () => {
  const b: Board = { updated_at: "2026-11-26T09:00:00.000Z", decisions: [], glance: { waiting: [mine], tickets: [], others: [] } };
  writeFileSync(file, original.slice(0, original.indexOf(A) + A.length) + "\n" + JSON.stringify(b, null, 2) + "\n" + original.slice(original.indexOf(Z)));
  rmSync(events, { force: true });
};
const read = (): Board => {
  const s = readFileSync(file, "utf8");
  return JSON.parse(s.slice(s.indexOf(A) + A.length, s.indexOf(Z)));
};
const logLines = (): HotEvent[] => (existsSync(events) ? readFileSync(events, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ab-hot-route-"));
  file = join(root, "src/data/board.ts");
  events = join(root, "log/events.jsonl");
  mkdirSync(join(root, "src/data"), { recursive: true });
  process.env.AB_BIN = join(ROOT, "bin/ab.mjs");
  process.env.AB_EVENTS_FILE = events;
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [hotRoute(), hotLogRoute()],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  http = createHttpServer(server.middlewares);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  close = async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await server.close();
  };
});

afterAll(async () => {
  await close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(seed);

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${HOT_ROUTE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }).then(async (r) => [r.status, await r.text()] as const);
const ok = async (body: unknown) => {
  const [status, text] = await post(body, { Origin: "http://board.localhost:8085" });
  expect([status, text]).toEqual([200, expect.any(String)]);
  const r = JSON.parse(text);
  expect(Object.keys(r)).toEqual(["ok", "mark", "changed"]);
  expect(r.ok).toBe(true);
  return r as { ok: true; mark: HotMark; changed: boolean };
};
const raw = (method: string, path: string, host: string, body?: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request(`${base}${path}`, { method, agent: false, headers: { Host: host, "Content-Type": "application/json" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
const NO = JSON.stringify({ ok: false });

// Runs a refused request and checks that board.ts and the event log did not change at all.
async function refused(code: number, send: () => Promise<number | readonly [number, string]>) {
  const before = readFileSync(file, "utf8");
  const log = existsSync(events) ? readFileSync(events, "utf8") : null;
  const r = await send();
  if (typeof r === "number") expect(r).toBe(code);
  else expect(r).toEqual([code, NO]);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(existsSync(events) ? readFileSync(events, "utf8") : null).toBe(log);
}

const getLog = (query = "", headers: Record<string, string> = {}) =>
  fetch(`${base}${HOT_LOG_ROUTE}${query}`, { headers }).then(async (r) => ({ status: r.status, cache: r.headers.get("cache-control"), text: await r.text() }));

describe("POST /__ab/hot", () => {
  it("hot: runs ab hot --by user, writes the hot map, the glance PR and one event line", async () => {
    const r = await ok({ url: PR, hot: true });
    expect(HOT_BY).toBe("user");
    expect(r).toEqual({ ok: true, mark: { hot: true, by: "user", at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) }, changed: true });
    expect(read().hot).toEqual({ [PR]: r.mark });
    expect(read().glance.waiting).toEqual([{ ...mine, hot: true, hot_by: "user", hot_at: r.mark.at }]);
    expect(logLines()).toEqual([{ at: r.mark.at, kind: "hot", url: PR, by: "user" }]);
    expect(readFileSync(join(root, ".ab-log.jsonl"), "utf8")).toContain(`"op":"hot","link":"${PR}"`);

    // Already hot: nothing written, no event.
    const before = readFileSync(file, "utf8");
    expect(await ok({ url: PR, hot: true })).toEqual({ ok: true, mark: r.mark, changed: false });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(logLines()).toHaveLength(1);
  });

  it("unhot keeps a hot:false entry; a trailing slash, query or fragment keys on the canonical URL", async () => {
    await ok({ url: PR, hot: true });
    const u = await ok({ url: `${PR}/?tab=files#top`, hot: false });
    expect(u).toEqual({ ok: true, mark: { hot: false, by: "user", at: expect.any(String) }, changed: true });
    expect(read().hot).toEqual({ [PR]: u.mark });
    expect(read().glance.waiting).toEqual([{ ...mine, hot_by: "user", hot_at: u.mark.at }]);
    expect(logLines().map((e) => [e.kind, e.url, e.by])).toEqual([["hot", PR, "user"], ["unhot", PR, "user"]]);
    expect((await ok({ url: PR, hot: false })).changed).toBe(false);
    expect(logLines()).toHaveLength(2);
  });

  it("a PR with no board card (a feed row) records only the hot map entry", async () => {
    const glance = read().glance;
    const r = await ok({ url: FEED_ONLY, hot: true });
    expect(r.changed).toBe(true);
    expect(read().hot).toEqual({ [FEED_ONLY]: r.mark });
    expect(read().glance).toEqual(glance);
    expect(logLines()).toEqual([{ at: r.mark.at, kind: "hot", url: FEED_ONLY, by: "user" }]);
  });

  it("refuses a client-chosen by and any other bad body with 400, without writing", async () => {
    for (const body of [
      { url: PR, hot: true, by: "assistant" },
      { url: PR, hot: true, extra: 1 },
      { url: PR },
      { hot: true },
      { url: PR, hot: "yes" },
      { url: PR, hot: 1 },
      { url: 3, hot: true },
      { url: "https://github.com/bad_owner/example-api/pull/1", hot: true },
      { url: "http://github.com/acme/example-api/pull/1", hot: true },
      { url: "https://github.com/acme/example-api/issues/1", hot: true },
      { url: "https://example.com/acme/example-api/pull/1", hot: true },
      { url: `${PR} --by assistant`, hot: true },
      { url: `${PR}/files`, hot: true },
      [PR, true],
      null,
      "not json",
    ])
      await refused(400, () => post(body as unknown));
    await refused(400, () => post({ url: PR, hot: true, pad: "x".repeat(5 * 1024) }).catch(() => [400, NO] as const));
  });

  it("refuses other methods (405), foreign hosts and origins (403) and non-JSON bodies (415)", async () => {
    const get = await fetch(`${base}${HOT_ROUTE}`);
    expect([get.status, await get.text()]).toEqual([405, NO]);
    const body = JSON.stringify({ url: PR, hot: true });
    await refused(403, () => raw("POST", HOT_ROUTE, "evil.example:8085", body));
    await refused(403, () => raw("POST", HOT_ROUTE, "board.localhost.evil.example", body));
    for (const origin of ["https://evil.example", "http://board.localhost.evil.example:8085", "null"])
      await refused(403, () => post({ url: PR, hot: true }, { Origin: origin }));
    await refused(415, () => post({ url: PR, hot: true }, { "Content-Type": "text/plain" }));
  });
});

describe("GET /__ab/hot-log", () => {
  it("is its own path, not the live stream", () => {
    expect(HOT_LOG_ROUTE).toBe("/__ab/hot-log");
    expect(HOT_LOG_ROUTE).not.toBe(EVENTS_ROUTE);
  });

  it("returns the events, oldest first, and honours since", async () => {
    expect(await getLog()).toEqual({ status: 200, cache: "no-store", text: JSON.stringify({ events: [] }) });
    const h = await ok({ url: PR, hot: true });
    const f = await ok({ url: FEED_ONLY, hot: true });
    const u = await ok({ url: PR, hot: false });
    const all = JSON.parse((await getLog()).text).events;
    expect(all).toEqual([
      { at: h.mark.at, kind: "hot", url: PR, by: "user" },
      { at: f.mark.at, kind: "hot", url: FEED_ONLY, by: "user" },
      { at: u.mark.at, kind: "unhot", url: PR, by: "user" },
    ]);
    // Strictly after since.
    const after = await getLog(`?since=${encodeURIComponent(h.mark.at)}`);
    expect(after.status).toBe(200);
    expect(after.cache).toBe("no-store");
    expect(JSON.parse(after.text).events).toEqual(all.filter((e: HotEvent) => Date.parse(e.at) > Date.parse(h.mark.at)));
    expect(JSON.parse((await getLog(`?since=${encodeURIComponent(u.mark.at)}`)).text).events).toEqual([]);
    expect(JSON.parse((await getLog("?since=2000-01-01T00:00:00Z")).text).events).toEqual(all);
    expect(JSON.parse((await getLog("?since=2000-01-01T00:00:00.000-05:00", { Origin: "http://localhost:8085" })).text).events).toEqual(all);
  });

  it("skips bad lines, returns only the known fields, and at most the newest 500", async () => {
    mkdirSync(join(root, "log"), { recursive: true });
    const t0 = Date.parse("2026-11-01T00:00:00.000Z");
    const line = (n: number) => ({ at: new Date(t0 + n * 1000).toISOString(), kind: n % 2 ? "unhot" : "hot", url: `${PR.slice(0, -4)}${n}`, by: "cli" });
    appendFileSync(events, "not json\n" + JSON.stringify({ at: "x", kind: "hot", url: PR, by: "cli" }) + "\n" + JSON.stringify({ ...line(0), kind: "toggle" }) + "\n");
    for (let n = 0; n < 600; n++) appendFileSync(events, JSON.stringify({ ...line(n), secret: "dropped" }) + "\n");
    const got = JSON.parse((await getLog()).text).events;
    expect(got).toHaveLength(500);
    expect(got[0]).toEqual(line(100));
    expect(got.at(-1)).toEqual(line(599));
    expect(JSON.parse((await getLog(`?since=${line(589).at}`)).text).events).toEqual(Array.from({ length: 10 }, (_, k) => line(590 + k)));
  });

  it("refuses a bad since (400), other methods (405) and foreign hosts and origins (403)", async () => {
    for (const since of ["yesterday", "2026-11-26", "2026-13-40T00:00:00Z", "", "1732600000000"]) expect((await getLog(`?since=${encodeURIComponent(since)}`)).status).toBe(400);
    expect((await fetch(`${base}${HOT_LOG_ROUTE}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(405);
    expect(await raw("GET", HOT_LOG_ROUTE, "evil.example:8085")).toBe(403);
    expect((await getLog("", { Origin: "https://evil.example" })).status).toBe(403);
  });
});
