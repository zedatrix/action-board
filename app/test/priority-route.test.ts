import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Board, Decision } from "../src/data/types";
import { priorityRoute, PRIORITY_ROUTE } from "../vite.config";

// POST /__ab/priority on a dev server whose root is a temp dir: its src/data/board.ts is a temp board, and
// AB_BIN is the real bin/ab.mjs. The real board.ts is only read, for its wrapper text.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const A = "/* BOARD-JSON-START */";
const Z = "/* BOARD-JSON-END */";
const original = readFileSync(join(ROOT, "app/src/data/board.ts"), "utf8");

const d = (id: string, extra: Partial<Decision> = {}): Decision => ({
  id,
  card_ref: null,
  context: `Context for ${id}, a fixture card in the priority route tests.`,
  question: `Ship the ${id} fixture?`,
  what_happens_after: "Nothing real.",
  options: [{ id: "a", label: "A" }],
  created_at: "2026-11-10T09:00:00.000Z",
  updated_at: "2026-11-10T09:00:00.000Z",
  ...extra,
});
const decisions = [
  d("first", { priority: "low" }),
  d("target"),
  d("answered", { answer: { answer: "a", answer_label: "A", answered_by: "chat", answered_at: "2026-11-10T10:00:00.000Z" } }),
  d("last", { details: ["One", { label: "L", items: ["x"] }] }),
];

let root: string;
let file: string;
let vite: ViteDevServer;
let http: Server;
let base: string;
const savedBin = process.env.AB_BIN;

const seed = () => {
  const b: Board = { updated_at: "2026-11-10T09:00:00.000Z", decisions, glance: { waiting: [], tickets: [], others: [] } };
  writeFileSync(file, original.slice(0, original.indexOf(A) + A.length) + "\n" + JSON.stringify(b, null, 2) + "\n" + original.slice(original.indexOf(Z)));
};
const read = (): Board => {
  const s = readFileSync(file, "utf8");
  return JSON.parse(s.slice(s.indexOf(A) + A.length, s.indexOf(Z)));
};

async function startServer(abBin: string) {
  process.env.AB_BIN = abBin;
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [priorityRoute()],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  const h = createHttpServer(server.middlewares);
  await new Promise<void>((resolve) => h.listen(0, "127.0.0.1", resolve));
  return { server, http: h, base: `http://127.0.0.1:${(h.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ab-priority-route-"));
  file = join(root, "src/data/board.ts");
  mkdirSync(join(root, "src/data"), { recursive: true });
  ({ server: vite, http, base } = await startServer(join(ROOT, "bin/ab.mjs")));
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await vite.close();
  if (savedBin === undefined) delete process.env.AB_BIN;
  else process.env.AB_BIN = savedBin;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(seed);

const post = (body: unknown, headers: Record<string, string> = {}, url = base) =>
  fetch(`${url}${PRIORITY_ROUTE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }).then(async (r) => [r.status, await r.text()] as const);
const rawPost = (host: string, body: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request(`${base}${PRIORITY_ROUTE}`, { method: "POST", agent: false, headers: { Host: host, "Content-Type": "application/json" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
const NO = JSON.stringify({ ok: false });

// Runs a refused request and checks that board.ts did not change at all.
async function refused(code: number, send: () => Promise<number | readonly [number, string]>) {
  const before = readFileSync(file, "utf8");
  const r = await send();
  if (typeof r === "number") expect(r).toBe(code);
  else expect(r).toEqual([code, NO]);
  expect(readFileSync(file, "utf8")).toBe(before);
}

describe("POST /__ab/priority", () => {
  it("runs ab priority: only that card's priority changes, every other card is identical", async () => {
    const before = read();
    const text = readFileSync(file, "utf8");
    expect(await post({ id: "target", priority: "high" }, { Origin: "http://board.localhost:8085" })).toEqual([200, JSON.stringify({ ok: true, priority: "high" })]);
    const after = read();
    expect(after.decisions.map((x) => x.id)).toEqual(before.decisions.map((x) => x.id));
    for (const [i, x] of after.decisions.entries()) {
      if (x.id === "target") expect(x).toStrictEqual({ ...before.decisions[i], priority: "high" });
      else expect(JSON.stringify(x)).toBe(JSON.stringify(before.decisions[i]));
    }
    expect(after.glance).toStrictEqual(before.glance);
    expect(after.decisions[1].updated_at).toBe("2026-11-10T09:00:00.000Z");
    // The wrapper outside the markers is untouched; no lock or temp file is left.
    const now = readFileSync(file, "utf8");
    expect(now.slice(0, now.indexOf(A))).toBe(text.slice(0, text.indexOf(A)));
    expect(now.slice(now.indexOf(Z))).toBe(text.slice(text.indexOf(Z)));
    expect(readFileSync(join(root, ".ab-log.jsonl"), "utf8")).toMatch(/"op":"priority","id":"target","priority":"high"\}/);

    expect(await post({ id: "target", priority: "low" })).toEqual([200, JSON.stringify({ ok: true, priority: "low" })]);
    expect(read().decisions[1].priority).toBe("low");
    expect(await post({ id: "first", priority: "medium" })).toEqual([200, JSON.stringify({ ok: true, priority: "medium" })]);
    expect(read().decisions[0].priority).toBe("medium");
  });

  it("maps an unknown id to 404 and an answered card to 409", async () => {
    await refused(404, () => post({ id: "nope", priority: "high" }));
    await refused(409, () => post({ id: "answered", priority: "high" }));
  });

  it("refuses a bad body with 400 without running ab", async () => {
    for (const body of [
      { id: "target", priority: "urgent" },
      { id: "target", priority: "HIGH" },
      { id: "target", priority: 1 },
      { id: "target" },
      { priority: "high" },
      { id: "", priority: "high" },
      { id: 3, priority: "high" },
      ["target", "high"],
      null,
      "not json",
    ])
      await refused(400, () => post(body as unknown));
    await refused(400, () => post({ id: "target", priority: "high", pad: "x".repeat(2048) }).catch(() => [400, NO] as const));
  });

  it("refuses other methods (405), foreign hosts and origins (403) and non-JSON bodies (415)", async () => {
    const get = await fetch(`${base}${PRIORITY_ROUTE}`);
    expect([get.status, await get.text()]).toEqual([405, NO]);
    await refused(405, () => fetch(`${base}${PRIORITY_ROUTE}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" }).then(async (r) => [r.status, await r.text()] as const));
    await refused(403, () => rawPost("evil.example:8085", JSON.stringify({ id: "target", priority: "high" })));
    await refused(403, () => rawPost("board.localhost.evil.example", JSON.stringify({ id: "target", priority: "high" })));
    for (const origin of ["https://evil.example", "http://board.localhost.evil.example:8085", "null"])
      await refused(403, () => post({ id: "target", priority: "high" }, { Origin: origin }));
    await refused(415, () => post({ id: "target", priority: "high" }, { "Content-Type": "text/plain" }));
  });

  it("answers 502 with only {ok:false} when ab fails another way", async () => {
    const bin = join(root, "broken-ab.mjs");
    writeFileSync(bin, 'console.error("secret detail http://hook.example/x"); process.exit(7);\n');
    const other = await startServer(bin);
    try {
      await refused(502, () => post({ id: "target", priority: "high" }, {}, other.base));
    } finally {
      process.env.AB_BIN = join(ROOT, "bin/ab.mjs");
      await new Promise<void>((resolve) => other.http.close(() => resolve()));
      await other.server.close();
    }
  });
});
