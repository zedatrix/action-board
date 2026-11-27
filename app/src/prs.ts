import type { Board, HotMark, OtherPR, PrFields, WaitingItem } from "./data/types";
import { parsePrRepos } from "./prRepos";
import type { PrFeedItem } from "./feedTypes";
import { linkKey } from "./prFeed";

// The PRs tab: every PR from glance.waiting and glance.others, filed under five sections. Review requests holds the
// PRs someone else authored; the other four hold the user's own.
export type PrSection = "hotfix" | "project" | "other" | "review_requests" | "other_repos";
export const PR_SECTIONS: { key: PrSection; label: string }[] = [
  { key: "hotfix", label: "Hotfixes" },
  { key: "project", label: "Project PRs" },
  { key: "other", label: "Non-project PRs" },
  { key: "review_requests", label: "Review requests" },
  { key: "other_repos", label: "Other repos" },
];

// Where a row came from, shown as a small label on it.
export type PrOrigin = "waiting" | "others";
export const PR_ORIGIN_LABEL: Record<PrOrigin, string> = { waiting: "Waiting on others", others: "Others' PRs with you" };
// feed is the row's PR in the GitHub feed (joined by link), when there is one.
export type PrRow = ({ origin: "waiting"; item: WaitingItem } | { origin: "others"; item: OtherPR }) & { feed?: PrFeedItem };

// The optional fallback before the feed identifies the signed-in viewer.
const DEFAULT_LOGIN = import.meta.env.ACTION_BOARD_GITHUB_LOGIN?.trim() ?? "";

const branch = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

// The project title convention: "Project " then a ticket code like BE-38b, FE-22a or QA-01o.
const PROJECT_TITLE = /^\s*project\s+[a-z]{2,3}-\d/i;

// The repos whose trunk is dev, so a PR into main there is a hotfix. Every other repo's PRs go to Other repos.
export const MAIN_REPOS = parsePrRepos(import.meta.env.ACTION_BOARD_PR_REPOS);

// Use owner/repo when available. Older feed entries may carry only the repo name.
export function repoOf(pr: { repo?: unknown; link?: unknown }): string {
  const m = typeof pr.link === "string" ? /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\//i.exec(pr.link.trim()) : null;
  const repo = branch(pr.repo);
  if (repo.includes("/")) return repo;
  if (m && (!repo || branch(m[2]) === repo)) return branch(`${m[1]}/${m[2]}`);
  return repo;
}

// A repo outside MAIN_REPOS. An unknown repo ("") counts as one of MAIN_REPOS, so such entries file as they always did.
export const isOtherRepo = (repo: string) => !!repo && MAIN_REPOS.length > 0 && !MAIN_REPOS.some((watch) =>
  watch === repo || (!repo.includes("/") && watch.endsWith(`/${repo}`)),
);

const isHotfixBase = (base: string) =>
  base === "main" || base === "master" || base.startsWith("release-") || base.startsWith("hotfix") || base.startsWith("hot-fix");

// First match wins: other_repos (a repo outside MAIN_REPOS, whatever its branches or title), then hotfix (base main,
// master, release-*, hotfix* or hot-fix*, or head hotfix/* or hot-fix/*), then project, else other. The title never
// makes a hotfix. When the base is known, base project alone decides project; only when no base is known do the
// fallbacks count: a project/* head or a title starting with a prefix like "Project BE-38b". Branch and repo names are trimmed and
// compared without case. Live glance entries often carry no base or head; prSections fills them (and the repo) from the
// GitHub feed when it has the PR. Review requests are decided before this, by prSections (isReviewRequest).
export function classifyPr(
  pr: PrFields & { title?: unknown; link?: unknown; repo?: unknown },
): Exclude<PrSection, "review_requests"> {
  const base = branch(pr.base);
  const head = branch(pr.head);
  const title = typeof pr.title === "string" ? pr.title : "";
  if (isOtherRepo(repoOf(pr))) return "other_repos";
  if (isHotfixBase(base) || head.startsWith("hotfix/") || head.startsWith("hot-fix/")) return "hotfix";
  if (base) return base === "project" ? "project" : "other";
  if (head.startsWith("project/") || PROJECT_TITLE.test(title)) return "project";
  return "other";
}

// Whether someone other than login authored the row's PR: the feed's author when the row is in the feed, else the
// glance.others item's own author. glance.waiting items are the user's own. Logins compare without case; a blank
// author counts as the user's.
export function isReviewRequest(r: PrRow, login: string = DEFAULT_LOGIN): boolean {
  const author = branch(r.feed?.author) || (r.origin === "others" ? branch(r.item.author) : "");
  const viewer = branch(login || DEFAULT_LOGIN);
  return viewer ? !!author && author !== viewer : r.feed ? !r.feed.mine : r.origin === "others";
}

// The board's explicit HOT toggles (Board.hot), keyed by canonical PR URL.
export type HotMap = Board["hot"];

// A PR link the way the server keys the hot map: trimmed, without #fragment, ?query or trailing slashes (case kept,
// so it is what POST /__ab/hot expects).
export function canonicalPrUrl(link: unknown): string {
  return typeof link === "string" ? link.trim().replace(/#.*$/, "").replace(/\?.*$/, "").replace(/\/+$/, "") : "";
}

// The hot map's entry for link, matched by linkKey (canonical, any case); the last match wins.
export function hotMark(link: unknown, hot: HotMap): HotMark | undefined {
  const key = linkKey(link);
  let mark: HotMark | undefined;
  if (key && hot) for (const [k, m] of Object.entries(hot)) if (linkKey(k) === key && m && typeof m.hot === "boolean") mark = m;
  return mark;
}

// Whether a row is HOT: its hot map entry when it has one (so an explicit unhot wins over the glance's hot: true),
// else the glance item's own hot: true.
export function isHot(row: { item: PrFields & { link?: unknown } }, hot: HotMap): boolean {
  const mark = hotMark(row.item.link, hot);
  return mark ? mark.hot : row.item.hot === true;
}

// The row's PR number: the feed's, else from the link's /pull/<n>; Infinity when neither has one.
function prNumber(r: PrRow): number {
  if (r.feed && r.feed.number > 0) return r.feed.number;
  const m = typeof r.item.link === "string" ? /\/pull\/(\d+)/.exec(r.item.link) : null;
  return m ? Number(m[1]) : Infinity;
}

// The order inside every section: HOT first (isHot against hot), then entries with the feed's created_at, oldest first,
// equal times by PR number; entries with no (or an unreadable) created_at come last in their HOT group, in the order given.
export function sortPrRows(entries: PrRow[], hot: HotMap = undefined): PrRow[] {
  const keyed = entries.map((r, i) => {
    const t = Date.parse(r.feed?.created_at ?? "");
    return { r, i, hot: isHot(r, hot), t: Number.isNaN(t) ? null : t, n: prNumber(r) };
  });
  keyed.sort((a, b) => {
    if (a.hot !== b.hot) return a.hot ? -1 : 1;
    if (a.t === null || b.t === null) return a.t === b.t ? a.i - b.i : a.t === null ? 1 : -1;
    return a.t - b.t || (a.n === b.n ? a.i - b.i : a.n < b.n ? -1 : 1);
  });
  return keyed.map((k) => k.r);
}

// A row as classifyPr sees it: the board row's own base and head win; a missing or blank one comes from the feed, and
// so does the repo.
const blank = (v: unknown) => typeof v !== "string" || !v.trim();
export function withFeedBranches(r: PrRow): PrRow["item"] & { repo?: string } {
  const { item, feed } = r;
  if (!feed) return item;
  return { ...item, repo: feed.repo, base: blank(item.base) ? feed.base : item.base, head: blank(item.head) ? feed.head : item.head };
}

// The row's repo when it is outside MAIN_REPOS (shown as a label on the row), else "".
export const otherRepoOf = (r: PrRow): string => {
  const repo = repoOf(withFeedBranches(r));
  return isOtherRepo(repo) ? repo : "";
};

// The five sections' entries (waiting items, then others, in file order): review requests first (isReviewRequest against
// login, the feed's signed-in user), then classifyPr; each section ordered by sortPrRows against hot, the board's hot
// map. byLink (feedByLink in prFeed.ts) joins each row to its GitHub feed PR by link; feed PRs with no row are not
// added (Assistant owns the list).
export function prSections(
  glance: Board["glance"],
  byLink: ReadonlyMap<string, PrFeedItem> = new Map(),
  hot: HotMap = undefined,
  login: string = DEFAULT_LOGIN,
): Record<PrSection, PrRow[]> {
  const join = (r: PrRow): PrRow => {
    const feed = byLink.get(linkKey(r.item.link));
    return feed ? { ...r, feed } : r;
  };
  const entries: PrRow[] = [
    ...glance.waiting.map((item) => join({ origin: "waiting", item })),
    ...(glance.others ?? []).map((item) => join({ origin: "others", item })),
  ];
  const out: Record<PrSection, PrRow[]> = { hotfix: [], project: [], other: [], review_requests: [], other_repos: [] };
  for (const r of entries) out[isReviewRequest(r, login) ? "review_requests" : classifyPr(withFeedBranches(r))].push(r);
  for (const k of Object.keys(out) as PrSection[]) out[k] = sortPrRows(out[k], hot);
  return out;
}
