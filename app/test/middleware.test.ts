import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startReceiver } from "./receiver";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const AUTH = "Basic dXNlcjpwYXNz extra";

let receiver: Awaited<ReturnType<typeof startReceiver>>;
let envDir: string;
let vite: ViteDevServer;
let http: Server;
let base: string;

beforeAll(async () => {
  // Shell env overrides .env files in loadEnv; keep this test on the temp env only.
  delete process.env.ACTION_BOARD_WEBHOOK_URL;
  delete process.env.ACTION_BOARD_WEBHOOK_AUTH;
  receiver = await startReceiver([201]);
  envDir = mkdtempSync(join(tmpdir(), "ab-env-"));
  writeFileSync(join(envDir, ".env.local"), `ACTION_BOARD_WEBHOOK_URL=${receiver.url}\nACTION_BOARD_WEBHOOK_AUTH=${AUTH}\n`);
  // The real vite.config.ts, with env read from the temp dir instead of app/.env.local.
  vite = await createServer({
    configFile: join(APP_DIR, "vite.config.ts"),
    root: APP_DIR,
    envDir,
    logLevel: "silent",
    // No dep pre-bundling: the page GET below would start it, and closing mid-run hangs vite.close().
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
  await receiver.close();
  rmSync(envDir, { recursive: true, force: true });
});

const payload = {
  event: "decision.answered",
  decision_id: "d-1",
  card_ref: null,
  question: "Ship it?",
  answer: "yes",
  answer_label: "Yes",
  answered_by: "app",
  answered_at: "2026-11-10T12:00:00.000Z",
};

const message = {
  event: "item.message",
  message_id: "00000000-0000-4000-8000-000000000001",
  item_id: "PROJ-5067",
  item_section: "tickets",
  item_title: "Status page: align weeks",
  item_status: "In Progress",
  item_link: "https://example.com/tickets/PROJ-5067",
  text: "Is this still on for Friday?",
  sent_at: "2026-11-10T12:00:00.000Z",
};

const todoMessage = {
  event: "todo.message",
  message_id: "00000000-0000-4000-8000-000000000002",
  todo_id: "review-banner",
  name: "Review the banner",
  priority: "high",
  due: null,
  comments: [],
  links: [],
  text: "Can you review this?",
  sent_at: "2026-11-10T12:00:00.000Z",
};

const rawPost = (host: string, body: string, headers: Record<string, string> = {}) =>
  new Promise<number>((resolve, reject) => {
    const req = request(`${base}/__ab/webhook`, { method: "POST", agent: false, headers: { Host: host, "Content-Type": "application/json", ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });

describe("POST /__ab/webhook", () => {
  it("forwards the body with the Authorization header and returns only {status}", async () => {
    const res = await fetch(`${base}/__ab/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:8085" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toStrictEqual({ status: 201 });
    expect(text).not.toContain(receiver.url);
    expect(text).not.toContain("dXNlcjpwYXNz");

    expect(receiver.received).toHaveLength(1);
    const req = receiver.received[0];
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe(AUTH);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body)).toStrictEqual(payload);
  });

  it("accepts the board's own origins, including http://board.localhost:8085", async () => {
    for (const origin of ["http://board.localhost:8085", "http://localhost:8085", "http://127.0.0.1:8085"]) {
      const before = receiver.received.length;
      const res = await fetch(`${base}/__ab/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(payload),
      });
      expect([origin, res.status, await res.json()]).toEqual([origin, 200, { status: 201 }]);
      expect(receiver.received.length).toBe(before + 1);
    }
  });

  it("serves the board.localhost host and refuses unknown hosts", async () => {
    const statusFor = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(`${base}/`, { headers: { Host: host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await statusFor("board.localhost:8085")).toBe(200);
    expect(await statusFor("localhost:8085")).toBe(200);
    expect(await statusFor("evil.example:8085")).toBe(403);
  });

  it("refuses other origins, non-JSON bodies and other payloads without forwarding", async () => {
    const before = receiver.received.length;
    const post = (headers: Record<string, string>, body: string) =>
      fetch(`${base}/__ab/webhook`, { method: "POST", headers, body }).then(async (r) => [r.status, await r.json()]);
    for (const origin of ["https://evil.example", "http://evil.example:8085", "http://board.localhost.evil.example:8085", "null"])
      expect(await post({ "Content-Type": "application/json", Origin: origin }, JSON.stringify(payload))).toEqual([403, { status: null }]);
    expect(await post({ "Content-Type": "text/plain" }, JSON.stringify(payload))).toEqual([415, { status: null }]);
    expect(await post({ "Content-Type": "application/json" }, '{"event":"other"}')).toEqual([400, { status: null }]);
    expect(await post({ "Content-Type": "application/json" }, "not json")).toEqual([400, { status: null }]);
    const get = await fetch(`${base}/__ab/webhook`);
    expect(get.status).toBe(405);
    // A page on another name that resolves to 127.0.0.1 (DNS rebinding) is same-origin to itself and sends
    // no Origin; Vite's allowedHosts check runs after this route, so the route checks Host itself.
    const rebound = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/__ab/webhook`, { method: "POST", headers: { Host: "evil.example:8085", "Content-Type": "application/json" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(JSON.stringify(payload));
    });
    expect(rebound).toBe(403);
    expect(receiver.received.length).toBe(before);
  });

  it.each([message, todoMessage])("forwards a $event body verbatim with the Authorization header", async (payload) => {
    const before = receiver.received.length;
    const body = JSON.stringify(payload);
    const res = await fetch(`${base}/__ab/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://board.localhost:8085" },
      body,
    });
    expect([res.status, await res.json()]).toEqual([200, { status: 201 }]);
    expect(receiver.received.length).toBe(before + 1);
    const req = receiver.received.at(-1)!;
    expect(req.headers.authorization).toBe(AUTH);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body).toBe(body);
  });

  it("refuses unknown events, foreign origins and foreign hosts for item.message without forwarding", async () => {
    const before = receiver.received.length;
    const post = (headers: Record<string, string>, body: string) =>
      fetch(`${base}/__ab/webhook`, { method: "POST", headers, body }).then(async (r) => [r.status, await r.json()]);
    for (const event of ["item.messages", "item.deleted", "", null, 1])
      expect(await post({ "Content-Type": "application/json" }, JSON.stringify({ ...message, event }))).toEqual([400, { status: null }]);
    const { event: _event, ...noEvent } = message;
    expect(await post({ "Content-Type": "application/json" }, JSON.stringify(noEvent))).toEqual([400, { status: null }]);
    expect(await post({ "Content-Type": "application/json", Origin: "https://evil.example" }, JSON.stringify(message))).toEqual([403, { status: null }]);
    expect(await rawPost("evil.example:8085", JSON.stringify(message))).toBe(403);
    expect(await rawPost("board.localhost.evil.example", JSON.stringify(message))).toBe(403);
    expect(receiver.received.length).toBe(before);
  });

  it("forwards a decision.clarify body verbatim with the Authorization header", async () => {
    const before = receiver.received.length;
    const body = JSON.stringify({
      event: "decision.clarify",
      decision_id: "d-1",
      question: "Ship it?",
      context: "The billing banner change is ready.",
      clicked_at: "2026-11-10T12:00:00.000Z",
    });
    const res = await fetch(`${base}/__ab/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://board.localhost:8085" },
      body,
    });
    expect([res.status, await res.json()]).toEqual([200, { status: 201 }]);
    expect(receiver.received.length).toBe(before + 1);
    const req = receiver.received.at(-1)!;
    expect(req.headers.authorization).toBe(AUTH);
    expect(req.body).toBe(body);
    for (const event of ["decision.clarified", "decision.Clarify"])
      expect(await rawPost("127.0.0.1", JSON.stringify({ event, decision_id: "d-1" }))).toBe(400);
    expect(receiver.received.length).toBe(before + 1);
  });

  it("forwards a decision.not_relevant body verbatim with the Authorization header", async () => {
    const before = receiver.received.length;
    const body = JSON.stringify({
      event: "decision.not_relevant",
      decision_id: "d-1",
      question: "Ship the billing banner?",
      cleared_at: "2026-11-10T12:00:00.000Z",
    });
    const res = await fetch(`${base}/__ab/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://board.localhost:8085" },
      body,
    });
    expect([res.status, await res.json()]).toEqual([200, { status: 201 }]);
    expect(receiver.received.length).toBe(before + 1);
    const req = receiver.received.at(-1)!;
    expect(req.headers.authorization).toBe(AUTH);
    expect(req.body).toBe(body);
    for (const event of ["decision.not-relevant", "decision.notRelevant", "decision.cleared"])
      expect(await rawPost("127.0.0.1", JSON.stringify({ event, decision_id: "d-1" }))).toBe(400);
    expect(receiver.received.length).toBe(before + 1);
  });

  it("caps an item.message body at the same 64 KB", async () => {
    const before = receiver.received.length;
    const big = JSON.stringify({ ...message, text: "x".repeat(65 * 1024) });
    const status = await rawPost("127.0.0.1", big).catch(() => "reset");
    expect([400, "reset"]).toContain(status);
    expect(receiver.received.length).toBe(before);
    expect(await rawPost("127.0.0.1", JSON.stringify({ ...message, text: "x".repeat(60 * 1024) }))).toBe(200);
    expect(receiver.received.length).toBe(before + 1);
  });
});
