import { useCallback, useMemo, useState } from "react";
import type { HotMark, PrFields } from "./data/types";
import { etTime } from "./eastern";
import { linkKey } from "./prFeed";
import { canonicalPrUrl, hotMark, type HotMap } from "./prs";

// The PRs tab's flame: POST /__ab/hot (vite.config.ts hotRoute), which only writes the board's hot map and the event
// log. It never calls GitHub or touches labels.
export const HOT_PATH = "/__ab/hot";
// Who the server records for the page's toggles (HOT_BY in vite.config.ts), shown until the reply has the real mark.
const PAGE_BY = "user";
const FAILED = "Couldn't save HOT. Try again.";

// Toggles one PR. Returns the mark the server wrote (or already had), or null for any failure.
export async function postHot(url: string, hot: boolean): Promise<HotMark | null> {
  try {
    const res = await window.fetch(HOT_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, hot }) });
    if (!res.ok) return null;
    const reply = await res.json().catch(() => null);
    const m = reply?.ok === true ? reply.mark : null;
    return m && typeof m.hot === "boolean" && typeof m.by === "string" && typeof m.at === "string" ? { hot: m.hot, by: m.by, at: m.at } : null;
  } catch {
    return null;
  }
}

type Local = { mark: HotMark; pending: boolean };
const without = <T,>(o: Record<string, T>, k: string) => {
  const { [k]: _, ...rest } = o;
  return rest;
};

// The board's hot map with the page's own toggles laid over it until the live board catches up: a toggle in flight
// always wins; a saved one wins while the board still has the other state and nothing newer. A failed toggle is
// rolled back and leaves an error for its row. Everything is keyed by linkKey, so it works for any PR row.
export function useHotToggles(boardHot: HotMap) {
  const [local, setLocal] = useState<Record<string, Local>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const hot = useMemo(() => {
    const out: Record<string, HotMark> = { ...boardHot };
    for (const [k, l] of Object.entries(local)) {
      const b = hotMark(k, boardHot);
      if (l.pending || !b || (b.hot !== l.mark.hot && !(Date.parse(b.at) > Date.parse(l.mark.at)))) out[k] = l.mark;
    }
    return out;
  }, [boardHot, local]);
  const pending = useCallback((link: unknown) => local[linkKey(link)]?.pending === true, [local]);
  const toggle = useCallback(async (link: string, next: boolean) => {
    const key = linkKey(link);
    setErrors((e) => without(e, key));
    setLocal((l) => ({ ...l, [key]: { mark: { hot: next, by: PAGE_BY, at: new Date().toISOString() }, pending: true } }));
    const mark = await postHot(canonicalPrUrl(link), next);
    setLocal((l) => (mark ? { ...l, [key]: { mark, pending: false } } : without(l, key)));
    if (!mark) setErrors((e) => ({ ...e, [key]: FAILED }));
  }, []);
  return { hot, pending, error: (link: unknown) => errors[linkKey(link)], toggle };
}

// A row's mark: its hot map entry, else the glance item's own hot_by / hot_at.
export function markOf(item: PrFields & { link?: unknown }, hot: HotMap): HotMark | undefined {
  const m = hotMark(item.link, hot);
  if (m) return m;
  return item.hot_by && item.hot_at ? { hot: item.hot === true, by: item.hot_by, at: item.hot_at } : undefined;
}

// "HOT by user 10:04 AM ET", or "HOT removed by ..." for an unhot.
export const markText = (m: HotMark) => `${m.hot ? "HOT" : "HOT removed"} by ${m.by} ${etTime(m.at)}`;

// Outline flame when off, solid orange when on. A button outside the row's link, so it never opens the PR.
export function HotFlame({ hot, mark, busy, onToggle }: { hot: boolean; mark?: HotMark; busy: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={hot ? "hot-flame on" : "hot-flame"}
      aria-label={hot ? "Remove HOT" : "Mark HOT"}
      aria-pressed={hot}
      title={mark ? markText(mark) : hot ? "Remove HOT" : "Mark HOT"}
      disabled={busy}
      onClick={onToggle}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <path d="M12 2.5C13 6 18 8.5 18 14a6 6 0 0 1-12 0c0-3 1.5-5 3-6 0 2 1 3.5 2.5 4-1-3.5-.5-7 .5-9.5z" />
      </svg>
    </button>
  );
}
