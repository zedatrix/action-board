import { useEffect, useState } from "react";
import { isBoard } from "./data/parse";
import type { Board } from "./data/types";

// Dev-server routes (see server/live.ts): the board as Server-Sent Events, and as plain JSON.
export const EVENTS_PATH = "/__ab/events";
export const BOARD_PATH = "/__ab/board";
export const POLL_MS = 2000;

// The board as the dev server currently has it. Starts from the bundled board.ts, then follows
// /__ab/events. While the stream is down it polls /__ab/board every POLL_MS until the stream is back,
// and it refetches when the window regains focus or becomes visible.
export function useLiveBoard(initial: Board): Board {
  const [board, setBoard] = useState(initial);

  useEffect(() => {
    let lastJson = JSON.stringify(initial);
    let source: EventSource | undefined;
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
      if (!isBoard(next)) return;
      lastJson = json;
      setBoard(next);
    };

    const refetch = async () => {
      const seq = streamSeq;
      try {
        const res = await window.fetch(BOARD_PATH, { cache: "no-store" });
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

    const connect = () => {
      if (typeof EventSource === "undefined") return;
      const es = new EventSource(EVENTS_PATH);
      source = es;
      es.addEventListener("open", stopPolling);
      es.addEventListener("board", (e) => {
        streamSeq++;
        stopPolling();
        apply((e as MessageEvent<string>).data);
      });
      // The browser retries a dropped stream on its own (readyState CONNECTING); a refused one (CLOSED)
      // is reopened by the poll tick below.
      es.addEventListener("error", startPolling);
    };

    function startPolling() {
      if (stopped || poll !== undefined) return;
      void refetch();
      poll = window.setInterval(() => {
        if (source?.readyState === 2 /* CLOSED */) {
          source.close();
          connect();
        }
        void refetch();
      }, POLL_MS);
    }

    const onFocus = () => void refetch();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };

    connect();
    if (!source) startPolling();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      stopPolling();
      source?.close();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // Only the first board seeds the feed; later ones come from the server.
  }, []);

  return board;
}
