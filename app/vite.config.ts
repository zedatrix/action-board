import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, normalizePath, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { FEED_FILE, createPrFeed, type PrFeedSource, type RefreshResult } from "./server/feed";
import { GITHUB_PULL_URL, parsePrRepos } from "./src/prRepos";
import { board as sampleBoard } from "./sample/board";
import { todos as sampleTodos } from "./sample/todos";
import { samplePrFeed } from "./sample/feed";
import { liveRoutes, watchBoard, watchTodos, type BoardWatcher, type LiveRoutes, type TodosWatcher } from "./server/live";

export const WEBHOOK_ROUTE = "/__ab/webhook";
export const BOARD_ROUTE = "/__ab/board";
export const TODOS_ROUTE = "/__ab/todos";
export const EVENTS_ROUTE = "/__ab/events";
export const FEED_ROUTE = "/__ab/feed";
export const FEED_REFRESH_ROUTE = "/__ab/feed/refresh";
export const DELIVERY_LOG_ROUTE = "/__ab/delivery-log";
export const PRIORITY_ROUTE = "/__ab/priority";
export const CLEAR_ROUTE = "/__ab/clear";
export const TODO_ROUTE = "/__ab/todo";
export const HOT_ROUTE = "/__ab/hot";
// The hot/unhot event log. Not /__ab/events: that path is the live SSE stream.
export const HOT_LOG_ROUTE = "/__ab/hot-log";
export const DELIVERY_LOG_FILE = ".delivery-log.jsonl";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_BODY_BYTES = 8 * 1024;
// Host and port: the shell's environment first, then app/.env.local (or app/.env), then the defaults.
// *.localhost names resolve to the loopback address in modern browsers; add-host.sh maps any other name.
const boardEnv = loadEnv(process.env.NODE_ENV === "production" ? "production" : "development", fileURLToPath(new URL(".", import.meta.url)), "ACTION_BOARD_");
export const BOARD_HOST = boardEnv.ACTION_BOARD_HOST?.trim().toLowerCase() || "board.localhost";
export const BOARD_PORT = Number(boardEnv.ACTION_BOARD_PORT) || 8085;
// localhost and 127.0.0.1 are always allowed, next to the configured host.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", BOARD_HOST]);

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isLocalOrigin(origin: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// Vite's allowedHosts check runs after plugin middlewares, so the /__ab routes check Host themselves.
function isLocalHost(host: string | undefined): boolean {
  return !!host && isLocalOrigin(`http://${host}`);
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrList = (v: unknown) => isStr(v) || (Array.isArray(v) && v.every(isStr));

// Events the /__ab/webhook fallback forwards; anything else is refused.
export const WEBHOOK_EVENTS = new Set(["decision.answered", "item.message", "decision.clarify", "decision.not_relevant"]);

const isOutcome = (b: Record<string, unknown>) =>
  (b.http === null || Number.isInteger(b.http)) &&
  (b.via === null || b.via === "direct" || b.via === "fallback") &&
  Number.isInteger(b.attempt) &&
  (b.attempt as number) >= 0 &&
  (b.status === "delivered" || b.status === "failed" || b.status === "retrying") &&
  isStr(b.at);
const isId = (v: unknown): v is string => isStr(v) && v.length > 0;

// Builds the delivery log line from a client report: only the known fields, in a fixed order, so a URL,
// auth value, message text or any other extra key is never written. Returns null if a field has the wrong type.
// A report without `event` is an answer report from before messages existed.
export function deliveryLogEntry(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (!isOutcome(b)) return null;
  const { http, via, attempt, status, at } = b;
  if (b.event === "item.message") {
    if (!isId(b.message_id) || !isId(b.item_id) || !isId(b.item_section)) return null;
    const { message_id, item_id, item_section } = b;
    return { event: "item.message", message_id, item_id, item_section, http, via, attempt, status, at };
  }
  // "Explain this better" and "Not relevant anymore": the id only, never the question or context text.
  if (b.event === "decision.clarify" || b.event === "decision.not_relevant") {
    if (!isId(b.decision_id)) return null;
    return { event: b.event, decision_id: b.decision_id, http, via, attempt, status, at };
  }
  if (b.event !== undefined && b.event !== "decision.answered") return null;
  if (!isId(b.decision_id) || !isStrOrList(b.answer) || !isStrOrList(b.answer_label)) return null;
  const { decision_id, answer, answer_label } = b;
  return { event: "decision.answered", decision_id, answer, answer_label, http, via, attempt, status, at };
}

// Dev-server fallback for when CORS blocks the browser's direct POST: the app sends the payload (an
// answer, a "Message the assistant" note, an "Explain this better" or a "Not relevant anymore" request, see WEBHOOK_EVENTS) here and this forwards it with ACTION_BOARD_WEBHOOK_URL / ACTION_BOARD_WEBHOOK_AUTH read from app/.env.local.
// Responds with only {status: <receiver HTTP status>}; never echoes the URL or auth.
// Also serves POST /__ab/delivery-log: the app reports each POST attempt there and it is appended to
// app/.delivery-log.jsonl (or `deliveryLogFile`) as one JSON line, without the URL or auth.
export function webhookForwarder(opts: { deliveryLogFile?: string } = {}): Plugin {
  let envDir = process.cwd();
  let mode = "development";
  let logFile = opts.deliveryLogFile ?? "";

  async function handleLog(req: IncomingMessage, res: ServerResponse) {
    const reply = (code: number) => {
      res.statusCode = code;
      res.end();
    };
    if (req.method !== "POST") return reply(405);
    if (!isLocalHost(req.headers.host)) return reply(403);
    if (req.headers.origin && !isLocalOrigin(req.headers.origin)) return reply(403);
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return reply(415);

    let entry: Record<string, unknown> | null;
    try {
      entry = deliveryLogEntry(JSON.parse(await readBody(req, MAX_LOG_BODY_BYTES)));
    } catch {
      return reply(400);
    }
    if (!entry) return reply(400);
    try {
      await appendFile(logFile, JSON.stringify(entry) + "\n");
      reply(204);
    } catch {
      reply(500);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const reply = (code: number, status: number | null) => {
      res.statusCode = code;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status }));
    };
    if (req.method !== "POST") return reply(405, null);
    if (!isLocalHost(req.headers.host)) return reply(403, null);
    // Only the board itself may use this route. Requiring JSON also forces a CORS preflight from other sites.
    if (req.headers.origin && !isLocalOrigin(req.headers.origin)) return reply(403, null);
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return reply(415, null);

    let body: string;
    try {
      body = await readBody(req);
      if (!WEBHOOK_EVENTS.has(JSON.parse(body)?.event)) return reply(400, null);
    } catch {
      return reply(400, null);
    }

    const env = loadEnv(mode, envDir, "ACTION_BOARD_");
    const url = env.ACTION_BOARD_WEBHOOK_URL;
    if (!url) return reply(503, null);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (env.ACTION_BOARD_WEBHOOK_AUTH) headers.Authorization = env.ACTION_BOARD_WEBHOOK_AUTH;
    try {
      const upstream = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(15000) });
      await upstream.arrayBuffer().catch(() => undefined);
      reply(200, upstream.status);
    } catch {
      reply(502, null);
    }
  }

  return {
    name: "action-board-webhook-forwarder",
    configResolved(config) {
      envDir = config.envDir;
      mode = config.mode;
      logFile ||= join(config.root, DELIVERY_LOG_FILE);
    },
    configureServer(server) {
      server.middlewares.use(WEBHOOK_ROUTE, (req, res) => void handle(req, res));
      server.middlewares.use(DELIVERY_LOG_ROUTE, (req, res) => void handleLog(req, res));
    },
  };
}

const PRIORITY_LEVELS = new Set(["high", "medium", "low"]);
const MAX_AB_BODY_BYTES = 1024;
// ab exit codes: 2 bad input, 4 answered, 5 unknown id (or lock timeout). Anything else, or a timeout, is 502.
const AB_EXIT_STATUS: Record<number, number> = { 2: 400, 4: 409, 5: 404 };
// `ab clear` exits 2 (bad input) or 5 (unknown id, or lock timeout); anything else, or a timeout, is 502.
const CLEAR_EXIT_STATUS: Record<number, number> = { 2: 400, 5: 404 };
// The reason the board's "Not relevant anymore" control clears with. Fixed here: the client cannot choose it.
export const NOT_RELEVANT_REASON = "not relevant";

// The hot/unhot event log ab appends to: AB_EVENTS_FILE, else data/events.jsonl in the repo (next to app/ and bin/).
const eventsFileFor = (root: string) => process.env.AB_EVENTS_FILE || join(root, "..", "data", "events.jsonl");

type AbCommand = { args: string[]; ok: object | ((stdout: string) => object) };

// A local-only POST route that runs one bin/ab.mjs command on this server's src/data/board.ts or todos.ts (under
// ab's lock), with AB_NO_SERVER=1: the watchers push the change to every open tab. `parse` turns the JSON object
// body into ab's arguments and the success reply (fixed, or built from ab's stdout), or null for a 400. Only
// `ok` builds a reply from ab's output; failures never carry it. ab is process.env.AB_BIN, else ../bin/ab.mjs
// next to the app. Unless `anyBody`, the body must carry a non-empty string id.
function abRoute(
  name: string,
  route: string,
  exitStatus: Record<number, number>,
  parse: (b: Record<string, unknown>) => AbCommand | null,
  { limit = MAX_AB_BODY_BYTES, anyBody = false } = {},
): Plugin {
  let boardFile = "";
  let todosFile = "";
  let abBin = "";
  let eventsFile = "";

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const reply = (code: number, body: object) => {
      res.statusCode = code;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    const fail = (code: number) => reply(code, { ok: false });
    if (req.method !== "POST") return fail(405);
    if (!isLocalHost(req.headers.host)) return fail(403);
    if (req.headers.origin && !isLocalOrigin(req.headers.origin)) return fail(403);
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return fail(415);

    let cmd: AbCommand | null;
    try {
      const b = JSON.parse(await readBody(req, limit));
      cmd = b && typeof b === "object" && !Array.isArray(b) && (anyBody || isId(b.id)) ? parse(b) : null;
    } catch {
      return fail(400);
    }
    if (!cmd) return fail(400);

    const env: NodeJS.ProcessEnv = { ...process.env, AB_FILE: boardFile, AB_TODOS_FILE: todosFile, AB_EVENTS_FILE: eventsFile, AB_NO_SERVER: "1" };
    delete env.AB_URL;
    const ok = cmd.ok;
    execFile(process.execPath, [abBin, ...cmd.args], { env, timeout: 15000 }, (err, stdout) => {
      if (!err) {
        try {
          return reply(200, typeof ok === "function" ? ok(stdout) : ok);
        } catch {
          return fail(502);
        }
      }
      const code = typeof err.code === "number" ? err.code : null;
      fail((code !== null && !err.killed && exitStatus[code]) || 502);
    });
  }

  return {
    name,
    apply: "serve",
    configResolved(config) {
      boardFile = join(config.root, "src/data/board.ts");
      todosFile = join(config.root, "src/data/todos.ts");
      abBin = process.env.AB_BIN || join(config.root, "..", "bin", "ab.mjs");
      eventsFile = eventsFileFor(config.root);
    },
    configureServer(server) {
      server.middlewares.use(route, (req, res) => void handle(req, res));
    },
  };
}

// POST /__ab/priority {"id","priority"}: the board's priority tap, `ab priority <id> <level>`.
// Replies {"ok":true,"priority"} or {"ok":false}.
export function priorityRoute(): Plugin {
  return abRoute("action-board-priority", PRIORITY_ROUTE, AB_EXIT_STATUS, (b) =>
    isStr(b.priority) && PRIORITY_LEVELS.has(b.priority) ? { args: ["priority", b.id as string, b.priority], ok: { ok: true, priority: b.priority } } : null,
  );
}

// POST /__ab/clear {"id"}: the board's "Not relevant anymore" control, `ab clear <id> --reason "not relevant"`
// (the tombstone keeps the card, so `ab restore <id>` brings it back). The app calls it only after the
// decision.not_relevant webhook got a 2xx. Replies {"ok":true}, or {"ok":false} with 404 (unknown id),
// 400 (bad input) or 502 (anything else, or a timeout).
export function clearRoute(): Plugin {
  return abRoute("action-board-clear", CLEAR_ROUTE, CLEAR_EXIT_STATUS, (b) => ({
    args: ["clear", b.id as string, "--reason", NOT_RELEVANT_REASON],
    ok: { ok: true },
  }));
}

// The to-do list's actions for POST /__ab/todo, and the body keys each passes on to `ab todo-<action>` (ab checks
// the values). A comment from the page is always by TODO_AUTHOR: the server sets it, the client cannot.
const TODO_ACTIONS = new Map<unknown, string[]>([
  ["add", ["name", "description", "priority", "due", "parent_id", "quick"]],
  ["update", ["id", "name", "description", "priority", "due", "parent_id"]],
  ["comment", ["id", "text"]],
  ["done", ["id"]],
  ["reopen", ["id"]],
]);
export const TODO_AUTHOR = "User";
const MAX_TODO_BODY_BYTES = 16 * 1024;
// ab todo-* exits 2 (bad input) or 5 (unknown id, or lock timeout); anything else, or a timeout, is 502.
const TODO_EXIT_STATUS: Record<number, number> = { 2: 400, 5: 404 };

// POST /__ab/todo {"action":"add"|"update"|"comment"|"done"|"reopen", ...that command's keys}: the Board's to-do
// list, `ab todo-<action> '<the other keys as JSON>'`. Replies {"ok":true,"todo":{...}} (the to-do as ab wrote it)
// or {"ok":false}: 400 for a bad body or ab exit 2, 404 for ab exit 5, 502 otherwise.
export function todoRoute(): Plugin {
  return abRoute(
    "action-board-todo",
    TODO_ROUTE,
    TODO_EXIT_STATUS,
    ({ action, ...rest }) => {
      const keys = TODO_ACTIONS.get(action);
      if (!keys || Object.keys(rest).some((k) => !keys.includes(k)) || (action !== "add" && !isId(rest.id))) return null;
      const input = action === "comment" ? { ...rest, author: TODO_AUTHOR } : rest;
      return { args: [`todo-${action}`, JSON.stringify(input)], ok: (stdout) => ({ ok: true, todo: JSON.parse(stdout).todo }) };
    },
    { limit: MAX_TODO_BODY_BYTES, anyBody: true },
  );
}

// A PR URL the PRs tab's flame may toggle: https://github.com/<owner>/<repo>/pull/<n>, optionally followed by / ? #
// (ab drops those and keys the mark on the canonical URL).
const MAX_HOT_BODY_BYTES = 4 * 1024;
// The server records UI toggles under the local user.
export const HOT_BY = "user";
// ab hot / unhot exits 2 for bad input; anything else (a lock timeout, a crash), or a timeout, is 502.
const HOT_EXIT_STATUS: Record<number, number> = { 2: 400 };

// POST /__ab/hot {"url","hot":true|false} (exactly those keys): the PRs tab's flame, `ab hot|unhot <url> --by user`.
// It only writes board.ts (the hot map, and the glance PR when there is one) and the event log; it never calls GitHub.
// Replies {"ok":true,"mark":{"hot","by","at"},"changed":<bool>} (changed false: it was already in that state, nothing
// written), or {"ok":false}: 400 for a bad body or ab exit 2, 502 otherwise.
export function hotRoute(): Plugin {
  return abRoute(
    "action-board-hot",
    HOT_ROUTE,
    HOT_EXIT_STATUS,
    (b) => {
      const keys = Object.keys(b).sort();
      if (keys.join() !== "hot,url" || typeof b.hot !== "boolean" || !isStr(b.url) || b.url.length > 300 || !GITHUB_PULL_URL.test(b.url)) return null;
      return {
        args: [b.hot ? "hot" : "unhot", b.url, "--by", HOT_BY],
        ok: (stdout) => {
          const r = JSON.parse(stdout);
          return { ok: true, mark: r.mark, changed: r.status === "changed" };
        },
      };
    },
    { limit: MAX_HOT_BODY_BYTES, anyBody: true },
  );
}

export type HotEvent = { at: string; kind: "hot" | "unhot"; url: string; by: string };
const MAX_HOT_EVENTS = 500;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// The event log's lines with at after since (ms; null = all), oldest first, at most the newest MAX_HOT_EVENTS. A missing
// file is an empty log; lines that do not parse or lack a field are skipped, and only the known fields are returned.
export async function readHotLog(file: string, since: number | null): Promise<HotEvent[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const events: HotEvent[] = [];
  for (const line of text.split("\n")) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object" || !isStr(e.at) || (e.kind !== "hot" && e.kind !== "unhot") || !isStr(e.url) || !isStr(e.by)) continue;
    const at = Date.parse(e.at);
    if (Number.isNaN(at) || (since !== null && at <= since)) continue;
    events.push({ at: e.at, kind: e.kind, url: e.url, by: e.by });
  }
  return events.slice(-MAX_HOT_EVENTS);
}

// GET /__ab/hot-log[?since=<ISO>]: {"events":[{"at","kind":"hot"|"unhot","url","by"},...]} from the event log, those
// after since (all when left out), oldest first, at most the newest 500. Local hosts and origins only, no-store.
// 405 for other methods, 403 for a foreign host or origin, 400 for a since that is not an ISO date-time.
export function hotLogRoute(): Plugin {
  let eventsFile = "";

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    const reply = (code: number, body?: object) => {
      res.statusCode = code;
      if (body) res.setHeader("Content-Type", "application/json");
      res.end(body ? JSON.stringify(body) : undefined);
    };
    if (req.method !== "GET") return reply(405);
    if (!isLocalHost(req.headers.host)) return reply(403);
    if (req.headers.origin && !isLocalOrigin(req.headers.origin)) return reply(403);
    const params = new URL(req.url ?? "/", "http://local").searchParams;
    const raw = params.get("since");
    let since: number | null = null;
    if (raw !== null) {
      since = ISO_UTC.test(raw) ? Date.parse(raw) : NaN;
      if (Number.isNaN(since)) return reply(400);
    }
    try {
      reply(200, { events: await readHotLog(eventsFile, since) });
    } catch {
      reply(500);
    }
  }

  return {
    name: "action-board-hot-log",
    apply: "serve",
    configResolved(config) {
      eventsFile = eventsFileFor(config.root);
    },
    configureServer(server) {
      server.middlewares.use(HOT_LOG_ROUTE, (req, res) => void handle(req, res));
    },
  };
}

const MAX_REFRESH_BODY_BYTES = 256;

// POST /__ab/feed/refresh: asks the PR feed for a run now (PrFeedSource.refresh), when the PRs tab is shown or the
// window comes back. The body is empty or any small JSON value, and is ignored. Answers {"ok":true,"started":true}
// without waiting for the run (the "feed" event brings its result), or {"ok":true,"started":false,"reason":
// "in-flight"|"debounced"|"quota"|"off"}. Refusals, like /__ab/hot: {"ok":false} with 405 (not POST), 403 (foreign
// Host or Origin), 415 (a body or content type that is not JSON) or 400 (bad JSON, or over 256 bytes).
export function feedRefreshHandler(feed: Pick<PrFeedSource, "refresh">) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (code: number, body: object) => {
      res.statusCode = code;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(body));
    };
    const fail = (code: number) => reply(code, { ok: false });
    if (req.method !== "POST") return fail(405);
    if (!isLocalHost(req.headers.host)) return fail(403);
    if (req.headers.origin && !isLocalOrigin(req.headers.origin)) return fail(403);
    const type = String(req.headers["content-type"] ?? "");
    if (type && !type.startsWith("application/json")) return fail(415);
    try {
      const body = await readBody(req, MAX_REFRESH_BODY_BYTES);
      if (body.trim()) {
        if (!type) return fail(415);
        JSON.parse(body);
      }
    } catch {
      return fail(400);
    }
    const r: RefreshResult = feed.refresh();
    reply(200, { ok: true, ...r });
  };
}

// Live board: watches src/data/board.ts and src/data/todos.ts and serves them at /__ab/board and /__ab/todos
// (JSON) and /__ab/events (SSE). The page renders from that feed, so edits to either file skip HMR: re-running
// App.tsx through React Refresh would also re-run its hooks (a second delivery instance, a fresh EventSource).
// Also the PR feed (server/feed.ts): seeded from app/.pr-feed.json, served at /__ab/feed and as "feed" events, and
// refreshed from GitHub every 2 minutes, except under vitest or with ACTION_BOARD_FEED=off.
export function liveBoard(): Plugin {
  let file = "";
  let todosFile = "";
  let feedFile = "";
  let fetchFeed = false;
  let sample = false;
  let repos: string[] = [];
  let watcher: BoardWatcher | undefined;
  let todos: TodosWatcher | undefined;
  let feed: PrFeedSource | undefined;
  let routes: LiveRoutes | undefined;
  const close = () => {
    routes?.close();
    watcher?.close();
    todos?.close();
    feed?.close();
  };

  return {
    name: "action-board-live",
    apply: "serve",
    configResolved(config) {
      file = normalizePath(join(config.root, "src/data/board.ts"));
      todosFile = normalizePath(join(config.root, "src/data/todos.ts"));
      feedFile = join(config.root, FEED_FILE);
      const env = loadEnv(config.mode, config.envDir, "ACTION_BOARD_");
      sample = config.mode === "sample";
      repos = parsePrRepos(env.ACTION_BOARD_PR_REPOS);
      fetchFeed = !process.env.VITEST && !sample && env.ACTION_BOARD_FEED !== "off" && repos.length > 0;
    },
    configureServer(server) {
      const logger = server.config.logger;
      const warn = (name: string) => (err: Error) => logger.warn(`[action-board] ${name} not applied yet: ${err.message}`);
      if (sample) {
        const fixed = <T,>(value: T) => ({ current: () => value, subscribe: () => () => {}, close: () => {} });
        watcher = fixed({ board: sampleBoard, json: JSON.stringify(sampleBoard) });
        todos = fixed({ todos: sampleTodos, json: JSON.stringify(sampleTodos) });
      } else {
        watcher = watchBoard(file, { onError: warn("board.ts") });
        todos = watchTodos(todosFile, { onError: warn("todos.ts") });
      }
      feed = createPrFeed(sample ? { initial: samplePrFeed } : { repos, cacheFile: feedFile });
      // Only a dev server that listens fetches: not middleware mode (vite-node, the tests).
      const pr = feed;
      if (fetchFeed) server.httpServer?.once("listening", () => pr.start());
      routes = liveRoutes(watcher, { allowHost: isLocalHost, allowOrigin: isLocalOrigin, todos, feed });
      server.middlewares.use(BOARD_ROUTE, routes.board);
      server.middlewares.use(TODOS_ROUTE, routes.todos);
      // Before FEED_ROUTE, which would otherwise take /__ab/feed/refresh too (connect matches by path prefix).
      const refresh = feedRefreshHandler(pr);
      server.middlewares.use(FEED_REFRESH_ROUTE, (req, res) => void refresh(req, res));
      server.middlewares.use(FEED_ROUTE, routes.feed);
      server.middlewares.use(EVENTS_ROUTE, routes.events);
      server.httpServer?.once("close", close);
    },
    handleHotUpdate(ctx) {
      if (ctx.file === file || ctx.file === todosFile || ctx.file === normalizePath(feedFile)) return [];
    },
    closeBundle: close,
  };
}

export default defineConfig(({ mode }) => {
  const sample = mode === "sample";
  const env = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "ACTION_BOARD_");
  const clientEnv = {
    ACTION_BOARD_ASSISTANT_NAME: sample ? "" : env.ACTION_BOARD_ASSISTANT_NAME,
    ACTION_BOARD_TIMEZONE: sample ? "" : env.ACTION_BOARD_TIMEZONE,
    ACTION_BOARD_WEBHOOK_URL: sample ? "" : env.ACTION_BOARD_WEBHOOK_URL,
    ACTION_BOARD_WEBHOOK_AUTH: sample ? "" : env.ACTION_BOARD_WEBHOOK_AUTH,
    ACTION_BOARD_PR_REPOS: sample ? "acme/example-api,acme/example-web" : env.ACTION_BOARD_PR_REPOS,
    ACTION_BOARD_GITHUB_LOGIN: sample ? "alice" : env.ACTION_BOARD_GITHUB_LOGIN,
  };
  return {
    plugins: [react(), liveBoard(), ...(sample ? [] : [webhookForwarder(), priorityRoute(), clearRoute(), todoRoute(), hotRoute(), hotLogRoute()])],
    define: Object.fromEntries(Object.entries(clientEnv).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value ?? "")])),
    resolve: {
      alias: sample ? ["board", "project", "todos"].map((name) => ({
        find: `./data/${name}`,
        replacement: fileURLToPath(new URL(`./sample/${name}.ts`, import.meta.url)),
      })) : [],
    },
    // Bind IPv4 loopback so a configured host mapped to 127.0.0.1 can connect.
    server: {
      host: "127.0.0.1",
      port: BOARD_PORT,
      strictPort: true,
      allowedHosts: [BOARD_HOST],
      open: !sample && process.env.AB_OPEN === "1" ? `http://${BOARD_HOST}:${BOARD_PORT}/` : false,
    },
  };
});
