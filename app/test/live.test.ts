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
import { liveRoutes, watchBoard, watchTodos, type BoardSnapshot, type BoardWatcher, type TodosSnapshot, type TodosWatcher } from "../server/live";
import type { Board, Todos } from "../src/data/types";
import { createPrFeed, type FeedSnapshot, type Gh } from "../server/feed";
import { emptyFeed, type PrFeed } from "../src/feedTypes";

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
const todosWith = (updated_at: string, ids: string[] = []): Todos => ({
  updated_at,
  items: ids.map((id) => ({ id, name: `To-do ${id}`, priority: "medium", comments: [], created_at: updated_at, updated_at })),
});
const cachedFeed: PrFeed = {
  ...emptyFeed(),
  fetched_at: "2026-11-26T12:00:00.000Z",
  github: { ok: true, login: "alice", error: null, last_ok: "2026-11-26T12:00:00.000Z" },
  rate_limit: { cost: 2, remaining: 4900, limit: 5000, resetAt: "2026-11-26T13:00:00Z", pages: 2 },
};
const feedSnap = (feed: PrFeed): FeedSnapshot => ({ feed, json: JSON.stringify(feed) });
const todosSource = (t: Todos) =>
  `import type { Todos } from "./types";\nexport const todos: Todos =\n/* TODOS-JSON-START */\n${JSON.stringify(t, null, 2)}\n/* TODOS-JSON-END */\n;\n`;

describe("watchTodos", () => {
  let dir: string;
  let watcher: TodosWatcher | undefined;
  afterEach(() => {
    watcher?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses on start, follows a temp file renamed over todos.ts, and keeps the last good list through a bad write", async () => {
    dir = mkdtempSync(join(tmpdir(), "ab-live-todos-"));
    const file = join(dir, "todos.ts");
    writeFileSync(file, todosSource(todosWith("2026-11-26T09:00:00.000Z")));
    const seen: TodosSnapshot[] = [];
    const errors: Error[] = [];
    watcher = watchTodos(file, { onError: (e) => errors.push(e) });
    watcher.subscribe((s) => seen.push(s));
    expect(watcher.current()?.todos.items).toEqual([]);

    writeFileSync(file + ".tmp", todosSource(todosWith("2026-11-26T09:01:00.000Z", ["a"])));
    renameSync(file + ".tmp", file);
    const s = await until(() => seen.at(-1), 2000, "rename");
    expect(s.todos.items.map((x) => x.id)).toEqual(["a"]);
    expect(JSON.parse(s.json)).toEqual(s.todos);

    writeFileSync(file, "export const todos = {};\n");
    await until(() => errors.length > 0, 2000, "parse error");
    expect(errors[0].message).toMatch(/todos markers missing/);
    expect(watcher.current()!.todos.updated_at).toBe("2026-11-26T09:01:00.000Z");
  });
});

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
  let todosFile: string;
  let vite: ViteDevServer;
  let http: Server;
  let base: string;

  beforeAll(async () => {
    // A minimal root: the real vite.config.ts only needs src/data/board.ts and todos.ts for these routes.
    root = mkdtempSync(join(tmpdir(), "ab-live-vite-"));
    mkdirSync(join(root, "src/data"), { recursive: true });
    boardFile = join(root, "src/data/board.ts");
    todosFile = join(root, "src/data/todos.ts");
    writeFileSync(boardFile, readFileSync(join(APP_DIR, "src/data/board.ts"), "utf8"));
    writeFileSync(todosFile, readFileSync(join(APP_DIR, "src/data/todos.ts"), "utf8"));
    // The PR feed's cache file: the server serves it at once (under vitest it never fetches from GitHub).
    writeFileSync(join(root, ".pr-feed.json"), JSON.stringify(cachedFeed));
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

    const d = { id: "live-1", title: "Live check card", context: "A test card for the live board check. It should show on the page within two seconds.", question: "Live?", what_happens_after: "It shows.", options: [{ id: "yes", label: "Yes" }], blocking: false };
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

  it("sends todos after the board on connect, then ab todo-add's to-do within 2s; /__ab/todos matches", async () => {
    const sse = await openEvents({ Origin: "http://localhost:8085" });
    await until(() => sse.events.length >= 2, 2000, "initial events");
    expect(sse.events.slice(0, 2).map((e) => e.event)).toEqual(["board", "todos"]);
    expect(JSON.parse(sse.events[1].data)).toMatchObject({ items: expect.any(Array) });

    const env: NodeJS.ProcessEnv = { ...process.env, AB_FILE: boardFile, AB_NO_SERVER: "1" };
    delete env.AB_TODOS_FILE;
    const started = Date.now();
    await promisify(execFile)(process.execPath, [join(ROOT, "bin/ab.mjs"), "todo-add", JSON.stringify({ id: "live-todo", name: "Live to-do check" })], { env });
    const ev = await until(
      () => sse.events.find((e) => e.event === "todos" && JSON.parse(e.data).items.some((x: { id: string }) => x.id === "live-todo")),
      2000,
      "todos event with live-todo",
    );
    expect(Date.now() - started).toBeLessThan(2000);

    const res = await fetch(`${base}/__ab/todos`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(ev.data);
    sse.close();
  });

  it("sends the cached PR feed after board and todos on connect; /__ab/feed serves the same JSON", async () => {
    const sse = await openEvents({ Origin: "http://board.localhost:8085" });
    await until(() => sse.events.length >= 3, 2000, "initial events");
    expect(sse.events.slice(0, 3).map((e) => e.event)).toEqual(["board", "todos", "feed"]);
    expect(JSON.parse(sse.events[2].data)).toEqual(cachedFeed);

    const res = await fetch(`${base}/__ab/feed`, { headers: { Origin: "http://localhost:8085" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(sse.events[2].data);
    sse.close();
  });

  it("refuses other origins, other hosts and other methods", async () => {
    for (const path of ["/__ab/board", "/__ab/events", "/__ab/todos", "/__ab/feed"]) {
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

  it("with todos: sends board then todos on connect, pushes todos changes, serves /__ab/todos; 503 until todos parse", async () => {
    const board = { board: boardWith("2026-11-10T09:00:00.000Z"), json: "" };
    board.json = JSON.stringify(board.board);
    const boardWatcher: BoardWatcher = { current: () => board, subscribe: () => () => {}, close: () => {} };
    const listeners = new Set<(s: TodosSnapshot) => void>();
    let snap: TodosSnapshot | null = null;
    const todos: TodosWatcher = { current: () => snap, subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)), close: () => {} };
    const routes = liveRoutes(boardWatcher, { allowHost: () => true, allowOrigin: () => true, todos });
    const bare = liveRoutes(boardWatcher, { allowHost: () => true, allowOrigin: () => true });
    const server = createHttpServer((req, res) => (req.url === "/todos" ? routes.todos : req.url === "/bare" ? bare.todos : routes.events)(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    expect((await fetch(`${url}/todos`)).status).toBe(503);
    expect((await fetch(`${url}/bare`)).status).toBe(503);
    snap = { todos: todosWith("2026-11-26T09:00:00.000Z", ["a"]), json: "" };
    snap.json = JSON.stringify(snap.todos);
    expect(await (await fetch(`${url}/todos`)).text()).toBe(snap.json);

    let text = "";
    const req = request(`${url}/`, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
    });
    req.end();
    await until(() => text.includes("event: todos"), 2000, "connect");
    expect(text).toBe(`event: board\ndata: ${board.json}\n\nevent: todos\ndata: ${snap.json}\n\n`);
    const next: TodosSnapshot = { todos: todosWith("2026-11-26T09:05:00.000Z", ["a", "b"]), json: "" };
    next.json = JSON.stringify(next.todos);
    for (const fn of listeners) fn(next);
    await until(() => text.endsWith(`event: todos\ndata: ${next.json}\n\n`), 2000, "pushed todos");
    req.destroy();
    await until(() => listeners.size === 0, 2000, "listener removed");
    routes.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("with the PR feed: serves /__ab/feed, sends it after board and todos, and pushes each run's feed; 403 for other hosts", async () => {
    const board = { board: boardWith("2026-11-10T09:00:00.000Z"), json: "" };
    board.json = JSON.stringify(board.board);
    const boardWatcher: BoardWatcher = { current: () => board, subscribe: () => () => {}, close: () => {} };
    const todos = { todos: todosWith("2026-11-26T09:00:00.000Z"), json: "" };
    todos.json = JSON.stringify(todos.todos);
    const todosWatcher: TodosWatcher = { current: () => todos, subscribe: () => () => {}, close: () => {} };
    const page = JSON.stringify({
      data: {
        viewer: { login: "alice" },
        rateLimit: { cost: 1, remaining: 4999, limit: 5000, resetAt: "2026-11-26T13:00:00Z" },
        search: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ number: 7, title: "T", url: "https://github.com/acme/a/pull/7", author: { login: "alice" }, updatedAt: "2026-11-26T11:00:00Z" }],
        },
      },
    });
    const gh: Gh = async () => page;
    const feed = createPrFeed({ repos: ["acme/example-api"], gh, log: () => {} });
    const allowHost = (h: string | undefined) => h?.startsWith("127.0.0.1") ?? false;
    const routes = liveRoutes(boardWatcher, { allowHost, allowOrigin: () => true, todos: todosWatcher, feed });
    const bare = liveRoutes(boardWatcher, { allowHost, allowOrigin: () => true });
    const server = createHttpServer((req, res) => (req.url === "/feed" ? routes.feed : req.url === "/bare" ? bare.feed : routes.events)(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    expect((await fetch(`${url}/bare`)).status).toBe(503);
    const first = await fetch(`${url}/feed`);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await first.text())).toEqual(emptyFeed());
    const evil = await new Promise<number>((resolve, reject) => {
      const req = request(`${url}/feed`, { headers: { Host: "evil.example" } }, (res) => (res.destroy(), resolve(res.statusCode ?? 0)));
      req.on("error", reject);
      req.end();
    });
    expect(evil).toBe(403);

    let text = "";
    const req = request(`${url}/`, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
    });
    req.end();
    await until(() => text.includes("event: feed"), 2000, "connect");
    expect(text).toBe(`event: board\ndata: ${board.json}\n\nevent: todos\ndata: ${todos.json}\n\nevent: feed\ndata: ${feedSnap(emptyFeed()).json}\n\n`);
    expect(await feed.tick()).toBe("ok");
    const json = feed.current().json;
    expect(JSON.parse(json).prs.map((p: { number: number; mine: boolean }) => [p.number, p.mine])).toEqual([[7, true]]);
    await until(() => text.endsWith(`event: feed\ndata: ${json}\n\n`), 2000, "pushed feed");
    expect(await (await fetch(`${url}/feed`)).text()).toBe(json);
    req.destroy();
    routes.close();
    feed.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
