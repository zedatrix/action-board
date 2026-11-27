import { useEffect, useRef } from "react";
import { emptyFeed, isPrFeed, type PrFeed } from "./feedTypes";
import { useLiveFeed, type Feed } from "./useLiveFeed";

// Dev-server route (see server/live.ts and server/feed.ts): the GitHub PR feed as JSON.
export const FEED_PATH = "/__ab/feed";
// The server refetches GitHub every 2 minutes, so a slower poll than the board's is enough.
export const FEED_POLL_MS = 10_000;
// Dev-server route (vite.config.ts, feedRefreshHandler): asks the server for a feed run now.
export const FEED_REFRESH_PATH = "/__ab/feed/refresh";
// The page asks at most this often; the server has its own 60-second floor and quota checks on top.
export const REFRESH_DEBOUNCE_MS = 30_000;

const PR_FEED: Feed<PrFeed> = { path: FEED_PATH, event: "feed", check: isPrFeed, pollMs: FEED_POLL_MS };

// The PR feed as the dev server currently has it. Starts empty, then follows the "feed" events on /__ab/events,
// polling /__ab/feed every 10 seconds while the stream is down (see useLiveFeed). A body that fails isPrFeed is ignored;
// entries are coerced field by field where they are read (prFeed.ts, normalizeItem).
export function usePrFeed(): PrFeed {
  return useLiveFeed(emptyFeed(), PR_FEED);
}

// While shown (the PRs tab is on screen): POST /__ab/feed/refresh now, and again when the window regains focus or the
// document becomes visible, at most once every REFRESH_DEBOUNCE_MS. The answer is not read (the "feed" event brings
// any new data) and a failed call is ignored.
export function useFeedRefresh(shown: boolean) {
  const last = useRef(-Infinity);
  useEffect(() => {
    if (!shown) return;
    const ask = () => {
      const t = Date.now();
      if (t - last.current < REFRESH_DEBOUNCE_MS) return;
      last.current = t;
      try {
        fetch(FEED_REFRESH_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
      } catch {
        // No fetch: nothing to do.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") ask();
    };
    ask();
    window.addEventListener("focus", ask);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", ask);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [shown]);
}
