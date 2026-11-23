import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DELIVERY_LOG_FILE, webhookForwarder } from "../vite.config";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

let dir: string;
let logFile: string;
let vite: ViteDevServer;
let http: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ab-log-"));
  logFile = join(dir, DELIVERY_LOG_FILE);
  // The real plugin, writing to a temp file instead of app/.delivery-log.jsonl.
  vite = await createServer({
    configFile: false,
    root: APP_DIR,
    envDir: dir,
    logLevel: "silent",
    plugins: [webhookForwarder({ deliveryLogFile: logFile })],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false },
  });
  http = createHttpServer(vite.middlewares);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await vite.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => rmSync(logFile, { force: true }));

const entry = {
  event: "decision.answered",
  decision_id: "merge-42",
  answer: "merge",
  answer_label: "Merge now",
  http: 200,
  via: "direct",
  attempt: 1,
  status: "delivered",
  at: "2026-11-10T12:00:00.000Z",
};

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/__ab/delivery-log`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://board.localhost:8085", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, text: await r.text() }));

const lines = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

describe("POST /__ab/delivery-log", () => {
  it("creates the file and appends one sanitized JSON line per report, returning 204", async () => {
    expect(existsSync(logFile)).toBe(false);
    expect(await post(entry)).toEqual({ status: 204, text: "" });
    const second = {
      ...entry,
      answer: ["riley", "blake"],
      answer_label: ["Riley", "Blake"],
      http: null,
      via: "fallback",
      attempt: 2,
      status: "retrying",
      url: "https://hooks.example/secret-path",
      auth: "Bearer s3cr3t",
      Authorization: "Bearer s3cr3t",
      headers: { Authorization: "Bearer s3cr3t" },
    };
    expect((await post(second)).status).toBe(204);

    const raw = readFileSync(logFile, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).not.toContain("hooks.example");
    expect(raw).not.toContain("s3cr3t");
    const [a, b] = lines();
    expect(lines()).toHaveLength(2);
    expect(a).toStrictEqual(entry);
    expect(Object.keys(b)).toEqual(["event", "decision_id", "answer", "answer_label", "http", "via", "attempt", "status", "at"]);
    expect(b).toStrictEqual({ ...entry, answer: ["riley", "blake"], answer_label: ["Riley", "Blake"], http: null, via: "fallback", attempt: 2, status: "retrying" });
  });

  it("writes an answer report without event (an older page) as decision.answered, fields unchanged", async () => {
    const { event: _event, ...legacy } = entry;
    expect((await post(legacy)).status).toBe(204);
    expect(lines()).toStrictEqual([entry]);
  });

  it("writes a message report: event, message_id, item_id, item_section and the outcome, never the text", async () => {
    const report = {
      event: "item.message",
      message_id: "00000000-0000-4000-8000-000000000001",
      item_id: "https://github.com/acme/example/pull/101",
      item_section: "waiting",
      http: 202,
      via: "fallback",
      attempt: 1,
      status: "delivered",
      at: "2026-11-10T12:00:00.000Z",
    };
    const sent = {
      ...report,
      text: "Ping Blake again please",
      item_title: "Team usage analytics",
      item_who: "Blake's re-review",
      url: "https://hooks.example/secret-path",
      Authorization: "Bearer s3cr3t",
      decision_id: "smuggled",
      answer: "x",
    };
    expect((await post(sent)).status).toBe(204);
    const raw = readFileSync(logFile, "utf8");
    for (const s of ["Ping Blake", "hooks.example", "s3cr3t", "smuggled", "item_title", "Blake's"]) expect(raw).not.toContain(s);
    expect(lines()).toStrictEqual([report]);
    expect(Object.keys(lines()[0])).toEqual(["event", "message_id", "item_id", "item_section", "http", "via", "attempt", "status", "at"]);
  });

  it("writes a clarify report: event, decision_id and the outcome, never the question, context, URL or auth", async () => {
    const report = {
      event: "decision.clarify",
      decision_id: "merge-42",
      http: 502,
      via: "direct",
      attempt: 2,
      status: "retrying",
      at: "2026-11-10T12:00:00.000Z",
    };
    const sent = {
      ...report,
      question: "Merge the checkout guard?",
      context: "Secret context words",
      clicked_at: "2026-11-10T11:59:59.000Z",
      url: "https://hooks.example/secret-path",
      Authorization: "Bearer s3cr3t",
      answer: "smuggled",
      answer_label: "smuggled",
    };
    expect((await post(sent)).status).toBe(204);
    const raw = readFileSync(logFile, "utf8");
    for (const s of ["Merge the hired", "Secret context", "clicked_at", "hooks.example", "s3cr3t", "smuggled"]) expect(raw).not.toContain(s);
    expect(lines()).toStrictEqual([report]);
    expect(Object.keys(lines()[0])).toEqual(["event", "decision_id", "http", "via", "attempt", "status", "at"]);
  });

  it("rejects bad clarify reports without writing", async () => {
    const ok = { event: "decision.clarify", decision_id: "d-1", http: null, via: "fallback", attempt: 1, status: "failed", at: "2026-11-10T12:00:00.000Z" };
    for (const body of [{ ...ok, decision_id: "" }, { ...ok, decision_id: 3 }, (({ decision_id: _d, ...rest }) => rest)(ok), { ...ok, status: "sent" }, { ...ok, via: "proxy" }])
      expect([body, (await post(body)).status]).toEqual([body, 400]);
    expect(existsSync(logFile)).toBe(false);
  });

  it("writes a not relevant report: event, decision_id and the outcome, never the question, URL or auth", async () => {
    const report = {
      event: "decision.not_relevant",
      decision_id: "merge-42",
      http: 200,
      via: "fallback",
      attempt: 1,
      status: "delivered",
      at: "2026-11-10T12:00:00.000Z",
    };
    const sent = {
      ...report,
      question: "Merge the checkout guard?",
      cleared_at: "2026-11-10T11:59:59.000Z",
      reason: "not relevant",
      url: "https://hooks.example/secret-path",
      Authorization: "Bearer s3cr3t",
      answer: "smuggled",
    };
    expect((await post(sent)).status).toBe(204);
    const raw = readFileSync(logFile, "utf8");
    for (const s of ["Merge the hired", "cleared_at", "reason", "hooks.example", "s3cr3t", "smuggled"]) expect(raw).not.toContain(s);
    expect(lines()).toStrictEqual([report]);
    expect(Object.keys(lines()[0])).toEqual(["event", "decision_id", "http", "via", "attempt", "status", "at"]);
  });

  it("rejects bad not relevant reports without writing", async () => {
    const ok = { event: "decision.not_relevant", decision_id: "d-1", http: null, via: "direct", attempt: 3, status: "failed", at: "2026-11-10T12:00:00.000Z" };
    for (const body of [{ ...ok, decision_id: "" }, { ...ok, decision_id: [] }, (({ decision_id: _d, ...rest }) => rest)(ok), { ...ok, status: "cleared" }, { ...ok, attempt: -1 }, { ...ok, event: "decision.not-relevant" }])
      expect([body, (await post(body)).status]).toEqual([body, 400]);
    expect(existsSync(logFile)).toBe(false);
  });

  it("rejects bad message reports and unknown events without writing", async () => {
    const msg = {
      event: "item.message",
      message_id: "m-1",
      item_id: "tickets:x",
      item_section: "tickets",
      http: null,
      via: null,
      attempt: 1,
      status: "failed",
      at: "2026-11-10T12:00:00.000Z",
    };
    const bad: unknown[] = [
      { ...msg, message_id: "" },
      { ...msg, message_id: 1 },
      { ...msg, item_id: "" },
      { ...msg, item_section: null },
      (({ item_id: _i, ...rest }) => rest)(msg),
      { ...msg, status: "pending" },
      { ...msg, event: "item.deleted" },
      { ...entry, event: "something.else" },
      { ...entry, event: 1 },
    ];
    for (const body of bad) expect([body, (await post(body)).status]).toEqual([body, 400]);
    expect(existsSync(logFile)).toBe(false);
    expect((await post(msg)).status).toBe(204);
  });

  it("accepts via null", async () => {
    expect((await post({ ...entry, via: null, http: null, status: "failed" })).status).toBe(204);
    expect(lines()).toHaveLength(1);
  });

  it("rejects bad bodies without writing", async () => {
    const bad: unknown[] = [
      "not json",
      "[]",
      "null",
      { ...entry, decision_id: "" },
      { ...entry, decision_id: 5 },
      { ...entry, answer: 1 },
      { ...entry, answer_label: [1] },
      { ...entry, http: "200" },
      { ...entry, http: 200.5 },
      { ...entry, via: "proxy" },
      { ...entry, attempt: -1 },
      { ...entry, attempt: "1" },
      { ...entry, status: "pending" },
      { ...entry, at: 0 },
      (({ at: _at, ...rest }) => rest)(entry),
    ];
    for (const body of bad) expect([body, (await post(body)).status]).toEqual([body, 400]);
    expect(await post(entry, { "Content-Type": "text/plain" }).then((r) => r.status)).toBe(415);
    expect((await fetch(`${base}/__ab/delivery-log`)).status).toBe(405);
    expect(existsSync(logFile)).toBe(false);
  });

  it("caps the body at 8 KB", async () => {
    const big = { ...entry, answer_label: "x".repeat(9 * 1024) };
    const status = await post(big).then((r) => r.status).catch(() => "reset");
    expect([400, "reset"]).toContain(status);
    expect(existsSync(logFile)).toBe(false);
    // Just under the cap is fine.
    expect((await post({ ...entry, answer_label: "x".repeat(7 * 1024) })).status).toBe(204);
  });

  it("refuses foreign origins and foreign hosts (DNS rebinding) without writing", async () => {
    for (const origin of ["https://evil.example", "http://board.localhost.evil.example:8085", "null"])
      expect((await post(entry, { Origin: origin })).status).toBe(403);
    const rebound = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${base}/__ab/delivery-log`,
        { method: "POST", headers: { Host: "evil.example:8085", "Content-Type": "application/json" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(entry));
    });
    expect(rebound).toBe(403);
    expect(existsSync(logFile)).toBe(false);
    for (const origin of ["http://localhost:8085", "http://127.0.0.1:8085"]) expect((await post(entry, { Origin: origin })).status).toBe(204);
  });
});
