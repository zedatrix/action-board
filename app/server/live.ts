// Live board for the dev server: watches board.ts, keeps the last good parse, and serves it as JSON
// (GET /__ab/board) and as Server-Sent Events (GET /__ab/events). Used by the plugin in vite.config.ts.
import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname } from "node:path";
import { parseBoardSource } from "../src/data/parse";
import type { Board } from "../src/data/types";

export type BoardSnapshot = { board: Board; json: string };

export type BoardWatcher = {
  current(): BoardSnapshot | null;
  subscribe(fn: (snap: BoardSnapshot) => void): () => void;
  close(): void;
};

export type WatchOptions = {
  debounceMs?: number;
  pollMs?: number;
  onError?: (err: Error) => void;
};

// bin/ab.mjs replaces board.ts by renaming a temp file over it, which orphans a watcher on the
// file itself. So: fs.watch on the directory (filtered by name), plus a stat poll as a backstop. Both feed
// one debounced re-read. A file that does not parse (mid-write, or a bad hand edit) keeps the last good
// board and is read again on the next poll tick.
export function watchBoard(file: string, opts: WatchOptions = {}): BoardWatcher {
  const debounceMs = opts.debounceMs ?? 100;
  const pollMs = opts.pollMs ?? 500;
  const name = basename(file);
  const listeners = new Set<(snap: BoardSnapshot) => void>();
  let snap: BoardSnapshot | null = null;
  let lastText: string | null = null;
  let lastSig = "";
  let retry = false;
  let lastError = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  const signature = () => {
    try {
      const s = statSync(file);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return "missing";
    }
  };

  function read() {
    timer = undefined;
    lastSig = signature();
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      return fail(err);
    }
    if (text === lastText) {
      retry = false;
      return;
    }
    let board: Board;
    try {
      board = parseBoardSource(text);
    } catch (err) {
      return fail(err);
    }
    retry = false;
    lastError = "";
    lastText = text;
    snap = { board, json: JSON.stringify(board) };
    for (const fn of listeners) fn(snap);
  }

  function fail(err: unknown) {
    retry = true;
    const e = err instanceof Error ? err : new Error(String(err));
    if (e.message !== lastError) opts.onError?.(e);
    lastError = e.message;
  }

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(read, debounceMs);
  };

  read();

  let dirWatcher: FSWatcher | undefined;
  try {
    dirWatcher = watch(dirname(file), (_event, filename) => {
      if (filename == null || filename.toString() === name) schedule();
    });
    dirWatcher.on("error", () => {
      dirWatcher?.close();
      dirWatcher = undefined;
    });
  } catch {
    // The poll below still picks up changes.
  }
  const poll = setInterval(() => {
    if (!timer && (retry || signature() !== lastSig)) schedule();
  }, pollMs);
  poll.unref?.();

  return {
    current: () => snap,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      dirWatcher?.close();
      listeners.clear();
    },
  };
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export type LiveRoutes = { board: Handler; events: Handler; close(): void };

export type RouteOptions = {
  // Host header check. Vite's allowedHosts check runs after plugin middlewares, so it does not cover these.
  allowHost: (host: string | undefined) => boolean;
  allowOrigin: (origin: string) => boolean;
  pingMs?: number;
};

export function liveRoutes(watcher: BoardWatcher, opts: RouteOptions): LiveRoutes {
  const pingMs = opts.pingMs ?? 15000;
  const streams = new Set<ServerResponse>();

  // Same rules as /__ab/webhook: only the board's own hosts and origins. Returns false after replying.
  function admit(req: IncomingMessage, res: ServerResponse): boolean {
    let code = 0;
    if (req.method !== "GET" && req.method !== "HEAD") code = 405;
    else if (!opts.allowHost(req.headers.host)) code = 403;
    else if (req.headers.origin && !opts.allowOrigin(req.headers.origin)) code = 403;
    else if (!watcher.current()) code = 503;
    if (!code) return true;
    res.statusCode = code;
    res.setHeader("Cache-Control", "no-store");
    res.end();
    return false;
  }

  const board: Handler = (req, res) => {
    if (!admit(req, res)) return;
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(req.method === "HEAD" ? undefined : watcher.current()!.json);
  };

  const events: Handler = (req, res) => {
    if (!admit(req, res)) return;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (req.method === "HEAD") return void res.end();
    const send = (snap: BoardSnapshot) => res.write(`event: board\ndata: ${snap.json}\n\n`);
    send(watcher.current()!);
    const unsubscribe = watcher.subscribe(send);
    const ping = setInterval(() => res.write(": ping\n\n"), pingMs);
    streams.add(res);
    const done = () => {
      clearInterval(ping);
      unsubscribe();
      streams.delete(res);
    };
    req.on("close", done);
    res.on("close", done);
  };

  return {
    board,
    events,
    close() {
      for (const res of streams) res.end();
      streams.clear();
    },
  };
}
