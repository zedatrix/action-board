import { useEffect, useState } from "react";

// Dev-server stream (see server/live.ts): one Server-Sent Events route with a named event per data file.
export const EVENTS_PATH = "/__ab/events";
export const POLL_MS = 2000;

export type Feed<T> = {
  // Plain JSON route for the same data, polled while the stream is down.
  path: string;
  // The SSE event name that carries it.
  event: string;
  // Shape check; anything else is ignored.
  check: (v: unknown) => v is T;
  // How often to poll path while the stream is down; POLL_MS when unset.
  pollMs?: number;
};

// One EventSource for the page, shared by every mounted feed: the server sends each file's event on the same
// stream. Opened by the first feed to join, closed when the last one leaves.
type Member = { event: string; data: (json: string) => void; open: () => void; error: () => void };
const members = new Set<Member>();
let source: EventSource | undefined;
let wired = new Set<string>();

function connect() {
  if (typeof EventSource === "undefined") return;
  const es = new EventSource(EVENTS_PATH);
  source = es;
  wired = new Set();
  const each = (fn: (m: Member) => void) => () => {
    if (es === source) for (const m of [...members]) fn(m);
  };
  es.addEventListener("open", each((m) => m.open()));
  es.addEventListener("error", each((m) => m.error()));
  for (const m of members) wire(m.event);
}

function wire(event: string) {
  const es = source;
  if (!es || wired.has(event)) return;
  wired.add(event);
  es.addEventListener(event, (e) => {
    if (es !== source) return;
    for (const m of [...members]) if (m.event === event) m.data((e as MessageEvent<string>).data);
  });
}

// Joins the shared stream, opening it if needed. Returns whether there is one (no EventSource: poll instead).
function join(m: Member): boolean {
  members.add(m);
  if (!source) connect();
  else wire(m.event);
  return !!source;
}

function leave(m: Member) {
  members.delete(m);
  if (members.size > 0) return;
  source?.close();
  source = undefined;
}

// The browser retries a dropped stream on its own (readyState CONNECTING); a refused one (CLOSED) is reopened here.
function reopenIfClosed() {
  if (source?.readyState !== 2 /* CLOSED */) return;
  source.close();
  connect();
}

// The data as the dev server currently has it. Starts from the bundled value, then follows the feed's event
// on EVENTS_PATH. While the stream is down it polls feed.path every feed.pollMs (POLL_MS) until the stream is back,
// and it refetches when the window regains focus or becomes visible.
export function useLiveFeed<T>(initial: T, feed: Feed<T>): T {
  const [value, setValue] = useState(initial);

  useEffect(() => {
    let lastJson = JSON.stringify(initial);
    let poll: number | undefined;
    let stopped = false;
    // Bumped by every stream event, so a poll response that started before one is dropped as stale.
    let streamSeq = 0;

    const apply = (json: string) => {
      if (stopped || json === lastJson) return;
      let next: unknown;
      try {
        next = JSON.parse(json);
      } catch {
        return;
      }
      if (!feed.check(next)) return;
      lastJson = json;
      setValue(next);
    };

    const refetch = async () => {
      const seq = streamSeq;
      try {
        const res = await window.fetch(feed.path, { cache: "no-store" });
        const json = res.ok ? await res.text() : null;
        if (json !== null && seq === streamSeq) apply(json);
      } catch {
        // Server down; the next tick tries again.
      }
    };

    const stopPolling = () => {
      window.clearInterval(poll);
      poll = undefined;
    };

    function startPolling() {
      if (stopped || poll !== undefined) return;
      void refetch();
      poll = window.setInterval(() => {
        reopenIfClosed();
        void refetch();
      }, feed.pollMs ?? POLL_MS);
    }

    const member: Member = {
      event: feed.event,
      data: (json) => {
        streamSeq++;
        stopPolling();
        apply(json);
      },
      open: stopPolling,
      error: startPolling,
    };

    if (!join(member)) startPolling();
    // Joined a stream that is already open: its first event for this feed has gone by, so fetch once.
    else if (source?.readyState === 1 /* OPEN */) void refetch();

    const onFocus = () => void refetch();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      stopPolling();
      leave(member);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // Only the first value seeds the feed; later ones come from the server.
  }, []);

  return value;
}
