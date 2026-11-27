// The PR feed the dev server fetches from GitHub (server/feed.ts) and serves at /__ab/feed and as the "feed" event
// on /__ab/events. Pure types and helpers only: the page imports this file too.

export type CiState = "passing" | "failing" | "pending" | "none";

// An unresolved review thread by its first comment, from a human.
export type PrThread = { author: string; path: string; body: string; url: string };

export const REVIEWER_STATES = ["CHANGES_REQUESTED", "APPROVED", "COMMENTED", "DISMISSED", "REQUESTED"] as const;

export type PrReviewer = {
  login: string;
  state: (typeof REVIEWER_STATES)[number];
  at: string;
  commit: string;
  on_head: boolean;
  requested: boolean;
};

export const isReviewerState = (state: unknown): state is PrReviewer["state"] =>
  REVIEWER_STATES.some((known) => known === state);

export type PrFeedItem = {
  link: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  // Opened by the signed-in gh user.
  mine: boolean;
  // Not fetched any more (the page never showed it); older cache files may still carry it.
  draft?: boolean;
  base: string;
  head: string;
  head_oid: string;
  review_decision: string | null;
  reviewers: PrReviewer[];
  ci: CiState;
  checks: { passed: number; failed: number; pending: number };
  failing_checks: number;
  labels: { name: string; color: string }[];
  // GitHub's totalCommentsCount.
  comments: number;
  additions: number;
  deletions: number;
  // Not fetched any more (the page never showed it); older cache files may still carry it.
  files?: number;
  // Human open threads whose first comments were fetched.
  unresolved_count: number;
  // The feed could not inspect every thread, so there may be more open ones ("N+ open threads").
  unresolved_more: boolean;
  // Those human open threads, newest first, each by its first comment.
  unresolved: PrThread[];
  // When the PR was opened (ISO), for the oldest-first order in each PRs tab section; "" when unknown (older cache
  // files have none).
  created_at: string;
  updated_at: string;
};

export type RateLimit = { cost: number; remaining: number; limit: number; resetAt: string; pages: number };

export type PrFeed = {
  // When the last run finished (ok or not); null before the first one.
  fetched_at: string | null;
  github: { ok: boolean; login: string | null; error: string | null; last_ok: string | null };
  rate_limit: RateLimit | null;
  prs: PrFeedItem[];
};

export const THREAD_BODY_MAX = 400;

export const emptyFeed = (): PrFeed => ({
  fetched_at: null,
  github: { ok: false, login: null, error: null, last_ok: null },
  rate_limit: null,
  prs: [],
});

export const cut = (s: unknown, max: number): string => (typeof s === "string" ? s.slice(0, max) : "");

// Only GitHub links go on the page; anything else becomes "".
export const githubUrl = (u: unknown): string => (typeof u === "string" && u.startsWith("https://github.com/") ? u : "");

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// Shape check for a feed from the server or the cache file (top level and each PR's link, number and title).
export function isPrFeed(v: unknown): v is PrFeed {
  if (!isObj(v) || !isObj(v.github) || !Array.isArray(v.prs)) return false;
  if (v.fetched_at !== null && typeof v.fetched_at !== "string") return false;
  if (v.rate_limit !== null && !isObj(v.rate_limit)) return false;
  return v.prs.every((p) => isObj(p) && typeof p.link === "string" && typeof p.number === "number" && typeof p.title === "string");
}
