import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { liveRoutes, watchBoard, type BoardSnapshot, type BoardWatcher } from "../server/live";
import type { Board } from "../src/data/types";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const APP_DIR = join(ROOT, "app");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
// The README's `ab raise` command, pointed at this checkout's bin/ab.mjs.
const [raiseCmd] = [...README.matchAll(/```sh\n(node bin\/ab\.mjs raise [^\n]+)\n```/g)].map((m) => m[1]);
const raise = (d: object) => `${raiseCmd.slice(0, raiseCmd.indexOf(" '")).replace("bin/ab.mjs", join(ROOT, "bin/ab.mjs"))} '${JSON.stringify(d)}'`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | null | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await sleep(20);
  }
}

const boardWith = (updated_at: string, ids: string[] = []): Board => ({
  updated_at,
  decisions: ids.map((id) => ({
    id,
    card_ref: null,
    question: `Q ${id}?`,
    what_happens_after: "x",
    options: [{ id: "yes", label: "Yes" }],
    created_at: updated_at,
  })),
  glance: { waiting: [], tickets: [] },
});
const source = (b: Board) =>
  `import type { Board } from "./types";\nexport const board: Board =\n/* BOARD-JSON-START */\n${JSON.stringify(b, null, 2)}\n/* BOARD-JSON-END */\n;\n`;

describe("watchBoard", () => {
  let dir: string;
  let file: string;
  let watcher: BoardWatcher | undefined;
  let seen: BoardSnapshot[];
  let errors: Error[];

  const start = () => {
    dir = mkdtempSync(join(tmpdir(), "ab-live-"));
    file = join(dir, "board.ts");
    writeFileSync(file, source(boardWith("2026-11-10T09:00:00.000Z")));
    seen = [];
    errors = [];
    watcher = watchBoard(file, { onError: (e) => errors.push(e) });
    watcher.subscribe((s) => seen.push(s));
  };
  const renameWrite = (text: string) => {
    writeFileSync(file + ".tmp", text);
    renameSync(file + ".tmp", file);
  };
  afterEach(() => {
    watcher?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses the file on start", () => {
    start();
    expect(watcher!.current()?.board.updated_at).toBe("2026-11-10T09:00:00.000Z");
  });

  it("calls back on an in-place write", async () => {
    start();
    writeFileSync(file, source(boardWith("2026-11-10T09:01:00.000Z", ["a"])));
    const s = await until(() => seen.at(-1), 2000, "change");
    expect(s.board.decisions.map((d) => d.id)).toEqual(["a"]);
    expect(JSON.parse(s.json)).toEqual(s.board);
  });

  it("detects a write to a temp file renamed over board.ts, and keeps watching after it", async () => {
    start();
    renameWrite(source(boardWith("2026-11-10T09:02:00.000Z", ["a"])));
    await until(() => seen.at(-1)?.board.updated_at === "2026-11-10T09:02:00.000Z", 2000, "first rename");
    renameWrite(source(boardWith("2026-11-10T09:03:00.000Z", ["a", "b"])));
    await until(() => seen.at(-1)?.board.updated_at === "2026-11-10T09:03:00.000Z", 2000, "second rename");
  });

  it("ends on the final content after two quick renames", async () => {
    start();
    renameWrite(source(boardWith("2026-11-10T09:04:00.000Z", ["a"])));
    renameWrite(source(boardWith("2026-11-10T09:05:00.000Z", ["a", "b"])));
    await until(() => seen.at(-1)?.board.updated_at === "2026-11-10T09:05:00.000Z", 2000, "final content");
    await sleep(700);
    expect(seen.at(-1)!.board.decisions.map((d) => d.id)).toEqual(["a", "b"]);
    expect(watcher!.current()!.board.updated_at).toBe("2026-11-10T09:05:00.000Z");
    // Coalesced or not, nothing stale arrives after the final content.
    expect(seen.map((s) => s.board.updated_at).filter((u) => u === "2026-11-10T09:05:00.000Z").length).toBe(1);
  });

  it("keeps the last good board while the file is half-written or invalid, then picks up the fix", async () => {
    start();
    const good = source(boardWith("2026-11-10T09:06:00.000Z", ["a"]));
    writeFileSync(file, good);
    await until(() => seen.at(-1)?.board.updated_at === "2026-11-10T09:06:00.000Z", 2000, "good write");
    const count = seen.length;
    writeFileSync(file, good.slice(0, good.length / 2));
    await until(() => errors.length > 0, 2000, "parse error");
    await sleep(700);
    expect(seen.length).toBe(count);
    expect(watcher!.current()!.board.updated_at).toBe("2026-11-10T09:06:00.000Z");
    writeFileSync(file, source({ ...boardWith("2026-11-10T09:07:00.000Z"), decisions: "nope" } as never));
    await sleep(400);
    expect(watcher!.current()!.board.updated_at).toBe("2026-11-10T09:06:00.000Z");
    renameWrite(source(boardWith("2026-11-10T09:08:00.000Z", ["a", "c"])));
    await until(() => seen.at(-1)?.board.updated_at === "2026-11-10T09:08:00.000Z", 2000, "fixed file");
  });
});

describe("/__ab/events and /__ab/board on the Vite dev server", () => {
  let root: string;
  let boardFile: string;
  let vite: ViteDevServer;
  let http: Server;
  let base: string;

  beforeAll(async () => {
    // A minimal root: the real vite.config.ts only needs src/data/board.ts for these routes.
    root = mkdtempSync(join(tmpdir(), "ab-live-vite-"));
    mkdirSync(join(root, "src/data"), { recursive: true });
    boardFile = join(root, "src/data/board.ts");
    writeFileSync(boardFile, readFileSync(join(APP_DIR, "src/data/board.ts"), "utf8"));
    vite = await createServer({
      configFile: join(APP_DIR, "vite.config.ts"),
      root,
      envDir: root,
      cacheDir: join(root, ".vite"),
      logLevel: "silent",
      server: { middlewareMode: true, hmr: false },
    });
    http = createHttpServer(vite.middlewares);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await vite.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  // Reads the SSE stream into parsed events.
  async function openEvents(headers: Record<string, string> = {}) {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/__ab/events`, { headers, signal: ctrl.signal });
    const events: { event: string; data: string }[] = [];
    let buf = "";
    let ended = false;
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          let k;
          while ((k = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, k);
            buf = buf.slice(k + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
            const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
            if (event) events.push({ event, data });
          }
        }
      } catch {
        // aborted
      }
      ended = true;
    })();
    return { res, events, close: () => ctrl.abort(), ended: () => ended };
  }

  it("sends the board on connect, then the README ab raise's decision within 2s; /__ab/board matches", async () => {
    const sse = await openEvents({ Origin: "http://board.localhost:8085" });
    expect(sse.res.status).toBe(200);
    expect(sse.res.headers.get("content-type")).toBe("text/event-stream");
    expect(sse.res.headers.get("cache-control")).toBe("no-store");
    const first = await until(() => sse.events[0], 2000, "initial event");
    expect(first.event).toBe("board");
    expect(JSON.parse(first.data).glance.waiting.length).toBeGreaterThan(0);

    const d = { id: "live-1", title: "Live check card", context: "A test card for the live board check. It should show on the page within two seconds.", question: "Live?", what_happens_after: "It shows.", options: [{ id: "yes", label: "Yes" }] };
    const started = Date.now();
    // Not AB_NO_SERVER: ab raise exits 0 only once this server's /__ab/board serves the decision.
    const env: NodeJS.ProcessEnv = { ...process.env, AB_FILE: boardFile, AB_URL: base };
    delete env.AB_NO_SERVER;
    const raised = promisify(execFile)("bash", ["-c", raise(d)], { env });
    const ev = await until(
      () => sse.events.find((e) => e.event === "board" && JSON.parse(e.data).decisions.some((x: { id: string }) => x.id === "live-1")),
      2000,
      "event with live-1",
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(JSON.parse((await raised).stdout)).toMatchObject({ ok: true, board: "live", card: { decision_id: "live-1" } });

    const res = await fetch(`${base}/__ab/board`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).toBe(ev.data);
    expect(JSON.parse(text).decisions.find((x: { id: string }) => x.id === "live-1")).toMatchObject({ question: "Live?", card_ref: null });
    sse.close();
  });

  it("refuses other origins, other hosts and other methods", async () => {
    for (const path of ["/__ab/board", "/__ab/events"]) {
      for (const origin of ["https://evil.example", "http://board.localhost.evil.example:8085", "null"]) {
        const res = await fetch(base + path, { headers: { Origin: origin } });
        expect([path, origin, res.status]).toEqual([path, origin, 403]);
      }
      const post = await fetch(base + path, { method: "POST" });
      expect(post.status).toBe(405);
      const status = (host: string) =>
        new Promise<number>((resolve, reject) => {
          const req = request(base + path, { headers: { Host: host } }, (res) => {
            res.destroy();
            resolve(res.statusCode ?? 0);
          });
          req.on("error", reject);
          req.end();
        });
      expect(await status("evil.example:8085")).toBe(403);
      expect(await status("board.localhost:8085")).toBe(200);
      expect(await status("localhost:8085")).toBe(200);
    }
  });
});

describe("liveRoutes", () => {
  it("pings, pushes every change, and drops its listener when the client goes away", async () => {
    const listeners = new Set<(s: BoardSnapshot) => void>();
    let snap: BoardSnapshot = { board: boardWith("2026-11-10T09:00:00.000Z"), json: "" };
    snap.json = JSON.stringify(snap.board);
    const watcher: BoardWatcher = {
      current: () => snap,
      subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      close: () => {},
    };
    const routes = liveRoutes(watcher, { allowHost: () => true, allowOrigin: () => true, pingMs: 50 });
    const server = createHttpServer((req, res) => routes.events(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let text = "";
    const req = request(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
    });
    req.end();
    await until(() => listeners.size === 1 && text.includes("event: board"), 2000, "connect");
    expect(text.startsWith(`event: board\ndata: ${snap.json}\n\n`)).toBe(true);
    await until(() => text.includes(": ping\n\n"), 2000, "ping");
    snap = { board: boardWith("2026-11-10T09:09:00.000Z", ["z"]), json: "" };
    snap.json = JSON.stringify(snap.board);
    for (const fn of listeners) fn(snap);
    await until(() => text.includes(`data: ${snap.json}\n\n`), 2000, "pushed change");
    req.destroy();
    await until(() => listeners.size === 0, 2000, "listener removed");
    routes.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
