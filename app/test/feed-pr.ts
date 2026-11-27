import type { PrFeed, PrFeedItem } from "../src/feedTypes";

// A GitHub feed PR for tests: User's (alice) example-api #n into dev, with no created_at and nothing to show
// unless extra says so.
export const feedPr = (n: number, extra: Partial<PrFeedItem> = {}): PrFeedItem => ({
  link: `https://github.com/acme/example-api/pull/${n}`,
  repo: "example-api",
  number: n,
  title: `PR ${n}`,
  author: "alice",
  mine: true,
  draft: false,
  base: "dev",
  head: `feature/${n}`,
  review_decision: null,
  head_oid: "",
  reviewers: [],
  ci: "none",
  checks: { passed: 0, failed: 0, pending: 0 },
  failing_checks: 0,
  labels: [],
  comments: 0,
  additions: 0,
  deletions: 0,
  files: 0,
  unresolved_count: 0,
  unresolved_more: false,
  unresolved: [],
  created_at: "",
  updated_at: "2026-11-26T15:00:00Z",
  ...extra,
});

export const feedOf = (prs: PrFeedItem[], extra: Partial<PrFeed> = {}): PrFeed => ({
  fetched_at: "2026-11-26T15:04:00Z",
  github: { ok: true, login: "alice", error: null, last_ok: "2026-11-26T15:04:00Z" },
  rate_limit: null,
  prs,
  ...extra,
});
