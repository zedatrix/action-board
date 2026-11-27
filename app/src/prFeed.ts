// Joins PRs tab entries to the GitHub PR feed (feedTypes.ts) by link, and the words for each row's chips.
// openReasons is adapted from Agent Board (MIT):
// mineOpenReasons in liveLists.ts.
import { githubUrl, isReviewerState, type CiState, type PrFeed, type PrFeedItem, type PrReviewer, type PrThread } from "./feedTypes";

// A PR link as a join key: trimmed, without #fragment, ?query or trailing slashes, lower case.
export function linkKey(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim().replace(/#.*$/, "").replace(/\?.*$/, "").replace(/\/+$/, "").toLowerCase();
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const CI: CiState[] = ["passing", "failing", "pending", "none"];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// One feed PR with every field the page reads coerced to its type, so a bad cache or server row cannot break a row.
// isPrFeed only checks link, number and title.
export function normalizeItem(v: unknown): PrFeedItem | null {
  if (!isObj(v) || typeof v.link !== "string") return null;
  const checks = isObj(v.checks) ? v.checks : {};
  const labels = Array.isArray(v.labels) ? v.labels.filter(isObj).map((l) => ({ name: str(l.name), color: str(l.color) })).filter((l) => l.name) : [];
  const unresolved: PrThread[] = Array.isArray(v.unresolved)
    ? v.unresolved.filter(isObj).map((t) => ({ author: str(t.author), path: str(t.path), body: str(t.body), url: githubUrl(t.url) }))
    : [];
  const reviewers: PrReviewer[] = [];
  for (const r of Array.isArray(v.reviewers) ? v.reviewers : []) {
    if (!isObj(r) || !isReviewerState(r.state)) continue;
    const login = str(r.login).trim();
    if (!login) continue;
    const at = str(r.at);
    reviewers.push({
      login,
      state: r.state,
      at: Number.isFinite(Date.parse(at)) ? at : "",
      commit: str(r.commit).slice(0, 8),
      on_head: r.on_head === true,
      requested: r.requested === true,
    });
  }
  return {
    link: v.link,
    repo: str(v.repo),
    number: num(v.number),
    title: str(v.title),
    author: str(v.author),
    mine: v.mine === true,
    draft: v.draft === true,
    base: str(v.base),
    head: str(v.head),
    review_decision: typeof v.review_decision === "string" ? v.review_decision : null,
    head_oid: str(v.head_oid),
    reviewers,
    ci: CI.includes(v.ci as CiState) ? (v.ci as CiState) : "none",
    checks: { passed: num(checks.passed), failed: num(checks.failed), pending: num(checks.pending) },
    failing_checks: num(v.failing_checks),
    labels,
    comments: num(v.comments),
    additions: num(v.additions),
    deletions: num(v.deletions),
    files: num(v.files),
    unresolved_count: Math.max(num(v.unresolved_count), unresolved.length),
    unresolved_more: v.unresolved_more === true,
    unresolved,
    created_at: str(v.created_at),
    updated_at: str(v.updated_at),
  };
}

// The feed's PRs by linkKey. The first PR with a given key wins.
export function feedByLink(feed: Pick<PrFeed, "prs"> | null | undefined): Map<string, PrFeedItem> {
  const out = new Map<string, PrFeedItem>();
  const prs: unknown = feed?.prs;
  for (const raw of Array.isArray(prs) ? prs : []) {
    const p = normalizeItem(raw);
    const k = p && linkKey(p.link);
    if (p && k && !out.has(k)) out.set(k, p);
  }
  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const reviewerName = (login: string) => login;

export function openReasons(p: PrFeedItem): string[] {
  const out: string[] = [];
  for (const r of p.reviewers) {
    if (r.state !== "CHANGES_REQUESTED") continue;
    const suffix = r.requested ? " · re-review requested" : r.on_head ? "" : " · pushed since, not re-requested";
    out.push(`changes requested by ${reviewerName(r.login)}${suffix}`);
  }
  const failed = p.failing_checks || p.checks.failed;
  if (failed > 0) out.push(plural(failed, "failing check", "failing checks"));
  const n = p.unresolved_count;
  if (p.unresolved_more) out.push(`${n}+ open threads`);
  else if (n > 0) out.push(plural(n, "open thread", "open threads"));
  return out;
}

const ET_CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

// "Last updated 3:49 PM ET": when the feed last ran, Eastern time.
export function lastUpdatedText(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "Last updated: unknown" : `Last updated ${ET_CLOCK.format(t).replace(/[  ]/g, " ")} ET`;
}

export const CI_LABEL: Record<Exclude<CiState, "none">, string> = { passing: "CI passing", failing: "CI failing", pending: "CI pending" };

export const commentsText = (n: number) => plural(n, "comment", "comments");

// A GitHub label color ("d73a4a") as a subtle tint; the text keeps the page's own color, so it stays readable.
// Anything that is not 6 hex digits gets no tint.
export function labelTint(color: string): { backgroundColor: string; borderColor: string } | undefined {
  if (!/^[0-9a-f]{6}$/i.test(color)) return undefined;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(color.slice(i, i + 2), 16));
  return { backgroundColor: `rgba(${r}, ${g}, ${b}, 0.18)`, borderColor: `rgba(${r}, ${g}, ${b}, 0.7)` };
}
