import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, normalizePath, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { liveRoutes, watchBoard, type BoardWatcher, type LiveRoutes } from "./server/live";

export const WEBHOOK_ROUTE = "/__ab/webhook";
export const BOARD_ROUTE = "/__ab/board";
export const EVENTS_ROUTE = "/__ab/events";
export const DELIVERY_LOG_ROUTE = "/__ab/delivery-log";
export const PRIORITY_ROUTE = "/__ab/priority";
export const CLEAR_ROUTE = "/__ab/clear";
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

// A local-only POST route that runs one bin/ab.mjs command on this server's src/data/board.ts (under ab's
// lock), with AB_NO_SERVER=1: the board watcher pushes the change to every open tab. `parse` turns the
// {"id",...} JSON body into ab's arguments and the success reply, or null for a 400. Replies never carry
// ab's output. ab is process.env.AB_BIN, else ../bin/ab.mjs next to the app.
function abRoute(
  name: string,
  route: string,
  exitStatus: Record<number, number>,
  parse: (b: Record<string, unknown>) => { args: string[]; ok: object } | null,
): Plugin {
  let boardFile = "";
  let abBin = "";

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

    let cmd: { args: string[]; ok: object } | null;
    try {
      const b = JSON.parse(await readBody(req, MAX_AB_BODY_BYTES));
      cmd = b && typeof b === "object" && !Array.isArray(b) && isId(b.id) ? parse(b) : null;
    } catch {
      return fail(400);
    }
    if (!cmd) return fail(400);

    const env: NodeJS.ProcessEnv = { ...process.env, AB_FILE: boardFile, AB_NO_SERVER: "1" };
    delete env.AB_URL;
    const ok = cmd.ok;
    execFile(process.execPath, [abBin, ...cmd.args], { env, timeout: 15000 }, (err) => {
      if (!err) return reply(200, ok);
      const code = typeof err.code === "number" ? err.code : null;
      fail((code !== null && !err.killed && exitStatus[code]) || 502);
    });
  }

  return {
    name,
    apply: "serve",
    configResolved(config) {
      boardFile = join(config.root, "src/data/board.ts");
      abBin = process.env.AB_BIN || join(config.root, "..", "bin", "ab.mjs");
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

// Live board: watches src/data/board.ts and serves it at /__ab/board (JSON) and /__ab/events (SSE).
// The page renders from that feed, so board.ts edits skip HMR: re-running App.tsx through React Refresh
// would also re-run its hooks (a second delivery instance, a fresh EventSource) on every edit.
export function liveBoard(): Plugin {
  let file = "";
  let watcher: BoardWatcher | undefined;
  let routes: LiveRoutes | undefined;
  const close = () => {
    routes?.close();
    watcher?.close();
  };

  return {
    name: "action-board-live",
    apply: "serve",
    configResolved(config) {
      file = normalizePath(join(config.root, "src/data/board.ts"));
    },
    configureServer(server) {
      const logger = server.config.logger;
      watcher = watchBoard(file, { onError: (err) => logger.warn(`[action-board] board.ts not applied yet: ${err.message}`) });
      routes = liveRoutes(watcher, { allowHost: isLocalHost, allowOrigin: isLocalOrigin });
      server.middlewares.use(BOARD_ROUTE, routes.board);
      server.middlewares.use(EVENTS_ROUTE, routes.events);
      server.httpServer?.once("close", close);
    },
    handleHotUpdate(ctx) {
      if (ctx.file === file) return [];
    },
    closeBundle: close,
  };
}

export default defineConfig({
  plugins: [react(), webhookForwarder(), liveBoard(), priorityRoute(), clearRoute()],
  envPrefix: ["VITE_", "ACTION_BOARD_"],
  // Loopback only, IPv4: Vite's default "localhost" can bind ::1 alone, which refuses a host mapped to 127.0.0.1.
  // start.sh sets AB_OPEN=1 to open the board in a browser; a background service leaves it unset.
  server: {
    host: "127.0.0.1",
    port: BOARD_PORT,
    strictPort: true,
    allowedHosts: [BOARD_HOST],
    open: process.env.AB_OPEN === "1" ? `http://${BOARD_HOST}:${BOARD_PORT}/` : false,
  },
});
