// Live board for the dev server: watches board.ts and todos.ts, keeps the last good parse of each, and serves them
// as JSON (GET /__ab/board, GET /__ab/todos) and as Server-Sent Events (GET /__ab/events, with "board" and "todos"
// events). Also serves the PR feed (server/feed.ts) at GET /__ab/feed and as "feed" events. Used by the plugin in
// vite.config.ts.
import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname } from "node:path";
import { parseBoardSource, parseTodosSource } from "../src/data/parse";
import type { Board, Todos } from "../src/data/types";
import type { FeedSnapshot } from "./feed";

export type BoardSnapshot = { board: Board; json: string };
export type TodosSnapshot = { todos: Todos; json: string };

export type SourceWatcher<S> = {
  current(): S | null;
  subscribe(fn: (snap: S) => void): () => void;
  close(): void;
};
export type BoardWatcher = SourceWatcher<BoardSnapshot>;
export type TodosWatcher = SourceWatcher<TodosSnapshot>;

export type WatchOptions = {
  debounceMs?: number;
  pollMs?: number;
  onError?: (err: Error) => void;
};

export function watchBoard(file: string, opts: WatchOptions = {}): BoardWatcher {
  return watchSource(file, opts, (text) => {
    const board = parseBoardSource(text);
    return { board, json: JSON.stringify(board) };
  });
}

export function watchTodos(file: string, opts: WatchOptions = {}): TodosWatcher {
  return watchSource(file, opts, (text) => {
    const todos = parseTodosSource(text);
    return { todos, json: JSON.stringify(todos) };
  });
}

// bin/ab.mjs replaces board.ts and todos.ts by renaming a temp file over them, which orphans a watcher on the
// file itself. So: fs.watch on the directory (filtered by name), plus a stat poll as a backstop. Both feed
// one debounced re-read. A file that does not parse (mid-write, or a bad hand edit; parse throws) keeps the
// last good snapshot and is read again on the next poll tick.
function watchSource<S>(file: string, opts: WatchOptions, parse: (text: string) => S): SourceWatcher<S> {
  const debounceMs = opts.debounceMs ?? 100;
  const pollMs = opts.pollMs ?? 500;
  const name = basename(file);
  const listeners = new Set<(snap: S) => void>();
  let snap: S | null = null;
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
    let next: S;
    try {
      next = parse(text);
    } catch (err) {
      return fail(err);
    }
    retry = false;
    lastError = "";
    lastText = text;
    snap = next;
    for (const fn of listeners) fn(next);
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

export type LiveRoutes = { board: Handler; todos: Handler; feed: Handler; events: Handler; close(): void };

export type RouteOptions = {
  // Host header check. Vite's allowedHosts check runs after plugin middlewares, so it does not cover these.
  allowHost: (host: string | undefined) => boolean;
  allowOrigin: (origin: string) => boolean;
  // The to-do list. Without it (or while todos.ts has never parsed) /__ab/todos answers 503 and the stream has
  // only board events.
  todos?: TodosWatcher;
  // The PR feed. Without it /__ab/feed answers 503 and the stream has no feed events.
  feed?: SourceWatcher<FeedSnapshot>;
  pingMs?: number;
};

export function liveRoutes(watcher: BoardWatcher, opts: RouteOptions): LiveRoutes {
  const pingMs = opts.pingMs ?? 15000;
  const streams = new Set<ServerResponse>();

  // Same rules as /__ab/webhook: only the board's own hosts and origins. Returns false after replying.
  function admit(req: IncomingMessage, res: ServerResponse, ready: boolean): boolean {
    let code = 0;
    if (req.method !== "GET" && req.method !== "HEAD") code = 405;
    else if (!opts.allowHost(req.headers.host)) code = 403;
    else if (req.headers.origin && !opts.allowOrigin(req.headers.origin)) code = 403;
    else if (!ready) code = 503;
    if (!code) return true;
    res.statusCode = code;
    res.setHeader("Cache-Control", "no-store");
    res.end();
    return false;
  }

  const json = (source: SourceWatcher<{ json: string }> | undefined): Handler => (req, res) => {
    if (!admit(req, res, !!source?.current())) return;
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(req.method === "HEAD" ? undefined : source!.current()!.json);
  };

  const events: Handler = (req, res) => {
    if (!admit(req, res, !!watcher.current())) return;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (req.method === "HEAD") return void res.end();
    const sendBoard = (snap: BoardSnapshot) => res.write(`event: board\ndata: ${snap.json}\n\n`);
    const sendTodos = (snap: TodosSnapshot) => res.write(`event: todos\ndata: ${snap.json}\n\n`);
    const sendFeed = (snap: FeedSnapshot) => res.write(`event: feed\ndata: ${snap.json}\n\n`);
    sendBoard(watcher.current()!);
    const todosNow = opts.todos?.current();
    if (todosNow) sendTodos(todosNow);
    const feedNow = opts.feed?.current();
    if (feedNow) sendFeed(feedNow);
    const unsubscribe = [watcher.subscribe(sendBoard), opts.todos?.subscribe(sendTodos), opts.feed?.subscribe(sendFeed)];
    const ping = setInterval(() => res.write(": ping\n\n"), pingMs);
    streams.add(res);
    const done = () => {
      clearInterval(ping);
      for (const off of unsubscribe) off?.();
      streams.delete(res);
    };
    req.on("close", done);
    res.on("close", done);
  };

  return {
    board: json(watcher),
    todos: json(opts.todos),
    feed: json(opts.feed),
    events,
    close() {
      for (const res of streams) res.end();
      streams.clear();
    },
  };
}
