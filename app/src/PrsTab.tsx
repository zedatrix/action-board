import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Board } from "./data/types";
import type { PrFeed } from "./feedTypes";
import { HotFlame, markOf, markText, useHotToggles } from "./HotFlame";
import { glanceItem, type BoardItem, type GlanceSection } from "./messages";
import { PrChips } from "./PrChips";
import { PrDetail } from "./PrDetail";
import { feedByLink, lastUpdatedText, linkKey } from "./prFeed";
import { GITHUB_PULL_URL } from "./prRepos";
import { PR_ORIGIN_LABEL, PR_SECTIONS, isHot, otherRepoOf, prSections, type HotMap, type PrRow, type PrSection } from "./prs";
import { useFeedRefresh, usePrFeed } from "./usePrFeed";

export type RenderMessage = (item: BoardItem) => ReactNode;

// Panel order on the tab: the two-column grid fills row by row, so Hotfixes | Non-project PRs sit on top and
// Project PRs | Tickets with no PR yet below; Review requests, then Other repos, each span the full width after them.
const panels = (keys: PrSection[]) => keys.map((key) => PR_SECTIONS.find((s) => s.key === key)!);
const TOP_PANELS = panels(["hotfix", "other", "project"]);
const WIDE_PANELS = panels(["review_requests", "other_repos"]);

// The PRs tab: every PR from glance.waiting and glance.others under Hotfixes, Non-project PRs, Project PRs, Review
// requests (PRs someone else authored) and Other repos (the viewer's PRs outside the configured repos), each in
// sortPrRows order (HOT, then oldest first), each row labeled with the list it came from; plus the tickets with no PR yet.
// App renders it (into the PRs tab panel) so its entries share the Board's live feed and Message Assistant composers.
// Entries whose link is in the GitHub PR feed (usePrFeed) also get chips, a chevron with details, and the feed's branches
// for sectioning; feed PRs with no row are not shown. hot is the board's hot map: with the page's own flame toggles
// over it (useHotToggles), it decides each row's HOT badge, flame and place in its section (isHot).
export function PrsTab({ glance, hot, renderMessage }: { glance: Board["glance"]; hot?: HotMap; renderMessage: RenderMessage }) {
  const feed = usePrFeed();
  const ref = useRef<HTMLElement>(null);
  useFeedRefresh(useShown(ref));
  const byLink = useMemo(() => feedByLink(feed), [feed]);
  const toggles = useHotToggles(hot);
  const sections = prSections(glance, byLink, toggles.hot, feed.github.login ?? undefined);
  const total = PR_SECTIONS.reduce((n, s) => n + sections[s.key].length, 0);
  // Open details by linkKey, so they stay open through live updates and a move to another section.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const prPanel = ({ key, label }: (typeof PR_SECTIONS)[number], wide = false) => (
    <Panel key={key} title={label} count={sections[key].length} section={key} wide={wide}>
      {keyed(sections[key]).map(({ key: k, row, ref }) => (
        <PrRowItem key={k} row={row} item={ref} message={renderMessage} open={open} onToggle={toggle} hot={toggles} />
      ))}
    </Panel>
  );
  return (
    <main className="prs" ref={ref}>
      <h2 className="kicker">
        PRs <span className="n">{total}</span>
      </h2>
      <div className="prs-grid">
        {TOP_PANELS.map((p) => prPanel(p))}
        <Panel title="Tickets with no PR yet" count={glance.tickets.length} section="tickets">
          {keyed(glance.tickets.map((item) => ({ origin: "tickets" as const, item }))).map(({ key, row: { item: t }, ref }) => (
            <Row key={key} item={ref} link={t.link} message={renderMessage}>
              <span className="title">
                <span className="tid">{t.id}</span>
                {t.title}
              </span>
              <span className={/review/i.test(t.status) ? "status review" : "status"}>{t.status}</span>
            </Row>
          ))}
        </Panel>
        {WIDE_PANELS.map((p) => prPanel(p, true))}
      </div>
      <FeedStatus feed={feed} />
    </main>
  );
}

// Whether the tab panel holding el is shown (no hidden attribute), followed as Tabs switches tabs. Starts false, so
// a hidden tab never counts as shown; true when el sits in no tab panel.
function useShown(ref: RefObject<HTMLElement>): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const panel = ref.current?.closest<HTMLElement>("[role=tabpanel]");
    if (!panel) return setShown(true);
    const read = () => setShown(!panel.hidden);
    read();
    const watch = new MutationObserver(read);
    watch.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    return () => watch.disconnect();
  }, [ref]);
  return shown;
}

// "Last updated 3:49 PM ET" (when the feed last ran), plus the last fetch's error when there was one (the entries keep
// the last good data meanwhile).
function FeedStatus({ feed }: { feed: PrFeed }) {
  const at = feed.fetched_at;
  const error = typeof feed.github?.error === "string" && feed.github.error.trim() ? feed.github.error.trim() : null;
  return (
    <footer className="pr-feed-status">
      <p>{at ? <time dateTime={at}>{lastUpdatedText(at)}</time> : "PR details from GitHub: not loaded yet"}</p>
      {error && (
        <p className="pr-feed-error" role="status">
          GitHub feed error: {error}, showing last good data
        </p>
      )}
    </footer>
  );
}

type Toggle = { open: ReadonlySet<string>; onToggle: (key: string) => void; hot: ReturnType<typeof useHotToggles> };

function PrRowItem({ row, item, message, open, onToggle, hot: toggles }: { row: PrRow; item: BoardItem; message: RenderMessage } & Toggle) {
  const pr = row.item;
  const feed = row.feed;
  const key = linkKey(pr.link);
  const canMark = typeof pr.link === "string" && GITHUB_PULL_URL.test(pr.link.trim());
  const expanded = Boolean(feed) && open.has(key);
  const detailId = `pr-detail-${item.item_section}-${key.replace(/[^a-z0-9]+/g, "-")}`;
  const hot = isHot(row, toggles.hot);
  const mark = markOf(pr, toggles.hot);
  const error = toggles.error(pr.link);
  const repo = otherRepoOf(row);
  return (
    <Row
      item={item}
      link={pr.link}
      message={message}
      hot={hot}
      lead={
        <span className="row-lead">
          {feed && (
            <button
              type="button"
              className="chev-btn"
              aria-expanded={expanded}
              aria-controls={expanded ? detailId : undefined}
              aria-label="Show details"
              onClick={() => onToggle(key)}
            >
              <span className="chev" aria-hidden="true" />
            </button>
          )}
          {canMark ? <HotFlame hot={hot} mark={mark} busy={toggles.pending(pr.link)} onToggle={() => void toggles.toggle(pr.link!, !hot)} /> : null}
        </span>
      }
      after={feed && expanded && <PrDetail pr={feed} id={detailId} />}
    >
      <span className="pr-main">
        <span className="pr-line">
          {hot && (
            <span className="hot-badge" title={mark?.hot ? markText(mark) : undefined}>
              HOT
            </span>
          )}
          <span className="title">{pr.title}</span>
          {repo && <span className="repo-chip">{repo}</span>}
        </span>
        {error && (
          <span className="hot-error" role="alert">
            {error}
          </span>
        )}
        {feed && <PrChips pr={feed} />}
        <span className="origin">{PR_ORIGIN_LABEL[row.origin]}</span>
      </span>
      <span className="meta">{row.origin === "others" ? `${row.item.author} · ${row.item.who}` : row.item.who}</span>
    </Row>
  );
}

function Item({ link, children }: { link?: string; children: ReactNode }) {
  if (!link) return <div className="item">{children}</div>;
  return (
    <a className="item" href={link} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

// wide: the panel spans both grid columns.
function Panel({ title, count, section, wide, children }: { title: string; count: number; section: string; wide?: boolean; children: ReactNode }) {
  return (
    <section className={wide ? "panel panel-wide" : "panel"} data-section={section}>
      <h3>
        {title} <span className="n">{count}</span>
      </h3>
      {count === 0 ? <p className="panel-empty">Nothing here.</p> : <ul>{children}</ul>}
    </section>
  );
}

type Origin = { origin: GlanceSection; item: Parameters<typeof glanceItem>[1] };

// React keys from the origin list and item_id, so entries (and their composers) follow the item, not its position.
// A repeated key within one section gets a suffix to keep keys unique.
function keyed<R extends Origin>(entries: R[]): { key: string; row: R; ref: BoardItem }[] {
  const seen = new Map<string, number>();
  return entries.map((row) => {
    const ref = glanceItem(row.origin, row.item);
    const base = `${row.origin}|${ref.item_id}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { key: n ? `${base}#${n}` : base, row, ref };
  });
}

type RowProps = { item: BoardItem; link?: string; message: RenderMessage; hot?: boolean; lead?: ReactNode; after?: ReactNode; children: ReactNode };

// lead (the chevron and HOT flame) sits before the link, outside it, so it never opens the PR; after (the details) spans the row.
function Row({ item, link, message, hot, lead, after, children }: RowProps) {
  const cls = ["row", hot && "hot", lead && "has-lead"].filter(Boolean).join(" ");
  return (
    <li className={cls} data-item-id={item.item_id} data-item-section={item.item_section}>
      {lead}
      <Item link={link}>{children}</Item>
      {message(item)}
      {after}
    </li>
  );
}
