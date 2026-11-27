// The PR feed: open pull requests in the configured repositories that involve the signed-in gh user (authored, assigned, mentioned,
// commented or asked to review), fetched by the dev server itself on a timer through `gh api graphql`. One paged
// GraphQL search and bounded batches for open thread comments per run. Served by server/live.ts at /__ab/feed
// and as the "feed" event on /__ab/events.
//
// Modeled on feed.ts (normalizePr, checksOf, unresolvedOf, startFeedTimer) from Agent Board.
// MIT License, Copyright (c) 2026 Agent Board contributors.
// See THIRD_PARTY_NOTICES.md.
import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  THREAD_BODY_MAX,
  cut,
  emptyFeed,
  githubUrl,
  isPrFeed,
  isReviewerState,
  type CiState,
  type PrFeed,
  type PrFeedItem,
  type RateLimit,
  type PrReviewer,
} from "../src/feedTypes";

type Json = Record<string, any>;

// Runs gh with these arguments and resolves with its stdout. Tests pass a fake.
export type Gh = (args: string[]) => Promise<string>;

export const FEED_INTERVAL_MS = 120_000;
export const PAGE_SIZE = 25;
export const MAX_PAGES = 8;
const THREAD_BATCH_SIZE = 100;
const MAX_THREAD_BATCHES = 5;
export const LABELS = 8;
// Below this many GraphQL points left, runs wait for the rate limit's resetAt.
export const LOW_QUOTA = 500;
// Below this many (until resetAt), a run starts no sooner than SLOW_INTERVAL_MS after the last one ended.
export const SLOW_QUOTA = 1500;
export const SLOW_INTERVAL_MS = 6 * 60_000;
// Wait after the 1st, 2nd, ... failed run in a row; the last value repeats. A good run resets it.
export const BACKOFF_MS = [2, 4, 8, 16, 30].map((m) => m * 60_000);
// "involves" covers authored PRs too. @me is the viewer whose login the same request returns.
export const searchQuery = (repos: readonly string[]) =>
  `${repos.map((repo) => `repo:${repo}`).join(" ")} is:pr is:open archived:false involves:@me`;
export const FEED_FILE = ".pr-feed.json";

// Only what normalizePr reads for the page. statusCheckRollup.contexts(first: 1) is only there for the per-state
// counts (check runs and status contexts); checksOf still reads contexts.nodes, as agent-board did, if a response
// carries nodes instead.
//
// Phase 1 counts 1 connection for search and 7 per PR (labels, reviewRequests, latestReviews,
// latestOpinionatedReviews, reviewThreads, commits and contexts). ceil((1 + 25 * 7) / 100) = 2 points.
// Phase 2 asks for one comments connection per open thread, about 2 points per batch of up to 100 IDs.
const PR_FIELDS = `
  number title url additions deletions reviewDecision createdAt updatedAt headRefName baseRefName headRefOid
  repository { nameWithOwner }
  author { login }
  labels(first: ${LABELS}) { nodes { name color } }
  reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } } } }
  latestReviews(first: 20) { nodes { author { login __typename } state submittedAt commit { oid } body } }
  latestOpinionatedReviews(first: 20) { nodes { author { login __typename } state submittedAt commit { oid } } }
  reviewThreads(last: 100) { totalCount nodes { id isResolved } }
  totalCommentsCount
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 1) {
    checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }
`;
export const PAGE_COST = Math.ceil((1 + PAGE_SIZE * 7) / 100);

export const GH_QUERY = `query($q: String!, $cursor: String) {
  viewer { login }
  rateLimit { cost remaining limit resetAt }
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`;

// First line only, capped, and anything shaped like a GitHub token blanked: gh's stderr is never logged whole.
export const errText = (e: unknown) =>
  String(e instanceof Error ? e.message : e)
    .split(process.env.GITHUB_TOKEN?.trim() || "\0").join("[token]")
    .split("\n")[0]
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+/g, "[token]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "[token]")
    .slice(0, 200);

function runGh(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { env, timeout: 60_000, maxBuffer: 32 << 20 }, (err, stdout) => {
      if (err) return reject(new Error("GitHub CLI request failed. Check gh auth status and repository access."));
      resolve(stdout);
    });
  });
}

// Read the credential once per refresh. Give it to gh in the environment, never in argv or diagnostics.
function githubCli(): Gh {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" };
  let auth: Promise<string> | undefined;
  return async (args) => {
    auth ??= env.GITHUB_TOKEN?.trim()
      ? Promise.resolve(env.GITHUB_TOKEN.trim())
      : runGh(["auth", "token"], env).then((token) => token.trim());
    const token = await auth;
    if (!token) throw new Error("GitHub CLI did not return a credential");
    return runGh(args, { ...env, GH_TOKEN: token });
  };
}

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "COMPLETED"]);
const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

// Check runs and status contexts on the PR's last commit, counted by outcome. Uses the per-state counts when the
// response has them, else the context nodes (CheckRun { status conclusion } / StatusContext { state }).
export function checksOf(pr: Json): { ci: CiState; checks: { passed: number; failed: number; pending: number } } {
  const roll = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const checks = { passed: 0, failed: 0, pending: 0 };
  const tally = (state: unknown, n = 1) => {
    const s = String(state);
    if (PASSED.has(s)) checks.passed += n;
    else if (FAILED.has(s)) checks.failed += n;
    else checks.pending += n;
  };
  const ctx = roll?.contexts ?? {};
  if (Array.isArray(ctx.checkRunCountsByState) || Array.isArray(ctx.statusContextCountsByState)) {
    for (const c of [...(ctx.checkRunCountsByState ?? []), ...(ctx.statusContextCountsByState ?? [])]) tally(c?.state, Number(c?.count) || 0);
  } else {
    for (const n of ctx.nodes ?? []) {
      if (n?.__typename === "CheckRun") tally(n.status === "COMPLETED" ? n.conclusion ?? "COMPLETED" : "PENDING");
      else if (n?.__typename === "StatusContext") tally(n.state);
    }
  }
  const s = roll?.state;
  const ci: CiState = !roll ? "none" : checks.failed > 0 || s === "FAILURE" || s === "ERROR" ? "failing" : s === "SUCCESS" ? "passing" : "pending";
  return { ci, checks };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Review comment authors that are tools, not people (compared without case). Any Bot account, and any login ending
// in [bot], is dropped too.
export const NOT_HUMAN = [
  "cursor",
  "cursor-bugbot",
  "bugbot",
  "github-actions",
  "codex",
  "chatgpt-codex-connector",
  "claude",
  "claude-code",
  "copilot",
  "copilot-pull-request-reviewer",
  "linear-code",
  "dependabot",
];
// Assistant signatures can identify automated comments posted under the viewer’s account.
export const FLEET = ["Assistant", "Test Helper", "Build Helper", "Review Bot", "Docs Helper", "Review Helper"];
const NAME = String.raw`(?:${FLEET.map((n) => n.replace(/ /g, String.raw`\s+`)).join("|")})\b`;
const DASH = "(?:—|–|--)";
// A fleet-signed comment (trimmed): it starts with a name label ("[Review Bot]", "Review Bot:", "**Review Bot**", "— Assistant", "-- Assistant",
// "– Assistant"), or its last line is a signature ("— Assistant", "-- Assistant"). A name in the middle of a sentence is not a signature.
export const FLEET_SIGNED = new RegExp(
  String.raw`^(?:\[\s*${NAME}\s*\]|\*\*\s*${NAME}\s*:?\s*\*\*|${NAME}\s*:|${DASH}\s*${NAME})|(?:^|\n)[ \t]*${DASH}[ \t]*${NAME}[ \t]*$`,
  "i",
);

function isHuman(author: Json | null | undefined, body: unknown, viewer: string): boolean {
  const login = String(author?.login ?? "").toLowerCase();
  if (author?.__typename === "Bot" || login.endsWith("[bot]") || NOT_HUMAN.includes(login)) return false;
  return !login || login !== viewer.toLowerCase() || !FLEET_SIGNED.test(String(body ?? "").trim());
}

function openThreadIds(pr: Json): string[] {
  return (pr.reviewThreads?.nodes ?? []).filter((t: Json) => t?.isResolved === false).map((t: Json) => t.id);
}

// Both the scan of thread IDs and the lookup of their first comments can be incomplete.
function unresolvedOf(pr: Json, viewer: string, firstComments: ReadonlyMap<string, Json | undefined>) {
  const fetched = (pr.reviewThreads?.nodes ?? []).filter(Boolean);
  const ids = openThreadIds(pr);
  const open = ids
    .map((id) => firstComments.get(id))
    .filter((c): c is Json => !!c && isHuman(c.author, c.body, viewer))
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  return {
    count: open.length,
    more: num(pr.reviewThreads?.totalCount) > fetched.length || ids.some((id) => !firstComments.has(id)),
    list: open.map((c) => ({ author: c.author?.login ?? "unknown", path: cut(c.path, 500), body: cut(c.body, THREAD_BODY_MAX), url: githubUrl(c.url) })),
  };
}

function reviewersOf(pr: Json, viewer: string): PrReviewer[] {
  const reviewers = new Map<string, PrReviewer>();
  const prAuthor = String(pr.author?.login ?? "").toLowerCase();
  for (const request of pr.reviewRequests?.nodes ?? []) {
    const user = request?.requestedReviewer;
    if (user?.__typename !== "User" || !user.login || !isHuman(user, "", viewer)) continue;
    const key = user.login.toLowerCase();
    if (key === prAuthor) continue;
    reviewers.set(key, { login: user.login, state: "REQUESTED", at: "", commit: "", on_head: false, requested: true });
  }

  const latest: Json[] = (pr.latestReviews?.nodes ?? []).filter(Boolean);
  const opinionated: Json[] = (pr.latestOpinionatedReviews?.nodes ?? []).filter(Boolean);
  const record = (review: Json, body: unknown) => {
    const login = review.author?.login;
    if (!login || !isReviewerState(review.state) || review.state === "REQUESTED" || !isHuman(review.author, body, viewer)) return;
    const key = login.toLowerCase();
    if (key === prAuthor) return;
    const oid = review.commit?.oid ?? "";
    reviewers.set(key, {
      login,
      state: review.state,
      at: review.submittedAt ?? "",
      commit: oid.slice(0, 8),
      on_head: !!oid && oid === pr.headRefOid,
      requested: reviewers.get(key)?.requested === true,
    });
  };
  for (const review of latest) record(review, review.body);
  for (const review of opinionated) {
    // Phase 1 includes the body only in latestReviews. Use it when both entries describe the same review.
    const match = latest.find((r) => r.author?.login === review.author?.login && r.state === review.state &&
      r.submittedAt === review.submittedAt && r.commit?.oid === review.commit?.oid);
    record(review, match?.body);
  }
  return [...reviewers.values()];
}

export function normalizePr(pr: Json, login: string, firstComments: ReadonlyMap<string, Json | undefined> = new Map()): PrFeedItem {
  const { ci, checks } = checksOf(pr);
  const unresolved = unresolvedOf(pr, login, firstComments);
  const author = pr.author?.login ?? "unknown";
  return {
    link: githubUrl(pr.url),
    repo: pr.repository?.nameWithOwner ?? pr.repository?.name ?? "",
    number: num(pr.number),
    title: cut(pr.title, 500),
    author,
    mine: !!login && author === login,
    base: pr.baseRefName ?? "",
    head: pr.headRefName ?? "",
    head_oid: pr.headRefOid ?? "",
    review_decision: pr.reviewDecision ?? null,
    reviewers: reviewersOf(pr, login),
    ci,
    checks,
    failing_checks: checks.failed,
    labels: (pr.labels?.nodes ?? []).filter(Boolean).map((l: Json) => ({ name: String(l.name ?? ""), color: String(l.color ?? "") })),
    comments: num(pr.totalCommentsCount),
    additions: num(pr.additions),
    deletions: num(pr.deletions),
    unresolved_count: unresolved.count,
    unresolved_more: unresolved.more,
    unresolved: unresolved.list,
    created_at: typeof pr.createdAt === "string" ? pr.createdAt : "",
    updated_at: pr.updatedAt ?? "",
  };
}

export type Page = { login: string; rateLimit: Omit<RateLimit, "pages">; hasNextPage: boolean; endCursor: string | null; nodes: Json[] };

// One `gh api graphql` answer. GraphQL errors with no data throw their first message.
export function parsePage(stdout: string): Page {
  const out = JSON.parse(stdout) as Json;
  const data = out?.data;
  if (!data?.search) throw new Error(`GitHub GraphQL: ${errText(out?.errors?.[0]?.message ?? "no data")}`);
  return {
    login: String(data.viewer?.login ?? ""),
    rateLimit: readRateLimit(data.rateLimit ?? {}),
    hasNextPage: !!data.search.pageInfo?.hasNextPage,
    endCursor: data.search.pageInfo?.endCursor ?? null,
    nodes: (data.search.nodes ?? []).filter((n: Json) => n && typeof n.number === "number"),
  };
}

function readRateLimit(rl: Json): Omit<RateLimit, "pages"> {
  return { cost: num(rl.cost), remaining: num(rl.remaining), limit: num(rl.limit), resetAt: String(rl.resetAt ?? "") };
}

async function fetchThreadBatch(gh: Gh, ids: string[]) {
  const query = `query {
    rateLimit { cost remaining limit resetAt }
    nodes(ids: ${JSON.stringify(ids)}) { ... on PullRequestReviewThread {
      id comments(first: 1) { nodes { author { login __typename } path body url createdAt } }
    } }
  }`;
  const out = JSON.parse(await gh(["api", "graphql", "-f", `query=${query}`])) as Json;
  if (out.errors?.length || !Array.isArray(out.data?.nodes) || !out.data.rateLimit) {
    throw new Error(`GitHub GraphQL review threads: ${errText(out.errors?.[0]?.message ?? "no data")}`);
  }
  return { nodes: out.data.nodes as (Json | null)[], rateLimit: readRateLimit(out.data.rateLimit) };
}

// Fetch all search pages before asking for open thread comments. Use the last response's quota and sum both phases' costs.
export async function fetchPrs(gh: Gh, repos: readonly string[]): Promise<{ login: string; prs: PrFeedItem[]; rate_limit: RateLimit }> {
  if (!repos.length) throw new Error("No GitHub repositories configured");
  const search = searchQuery(repos);
  let cursor: string | null = null;
  let pages = 0;
  let cost = 0;
  let last: Page;
  const byLink = new Map<string, Json>();
  do {
    const args = ["api", "graphql", "-f", `query=${GH_QUERY}`, "-f", `q=${search}`];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    last = parsePage(await gh(args));
    pages++;
    cost += last.rateLimit.cost;
    for (const pr of last.nodes) {
      byLink.set(githubUrl(pr.url) || `${pr.repository?.nameWithOwner ?? pr.repository?.name ?? ""}#${pr.number}`, pr);
    }
    cursor = last.endCursor;
  } while (last.hasNextPage && cursor && pages < MAX_PAGES);
  if (!last.login) throw new Error("gh is not signed in");
  const nodes = [...byLink.values()];
  const ids = [...new Set(nodes.flatMap(openThreadIds))]
    .filter((id) => typeof id === "string" && /^[A-Za-z0-9_=-]+$/.test(id))
    .slice(0, THREAD_BATCH_SIZE * MAX_THREAD_BATCHES);
  const firstComments = new Map<string, Json | undefined>();
  let rateLimit = last.rateLimit;
  for (let i = 0; i < ids.length; i += THREAD_BATCH_SIZE) {
    const batch = await fetchThreadBatch(gh, ids.slice(i, i + THREAD_BATCH_SIZE));
    rateLimit = batch.rateLimit;
    cost += rateLimit.cost;
    for (const thread of batch.nodes) {
      if (thread?.comments) firstComments.set(thread.id, thread.comments.nodes?.[0]);
    }
  }
  const prs = nodes.map((pr) => normalizePr(pr, last.login, firstComments))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { login: last.login, prs, rate_limit: { ...rateLimit, cost, pages } };
}

export type FeedSnapshot = { feed: PrFeed; json: string };
export type TickResult = "ok" | "error" | "busy" | "backoff" | "quota" | "slow";
// POST /__ab/feed/refresh's answer: a run started now, or why not.
export type RefreshResult = { started: true } | { started: false; reason: "in-flight" | "debounced" | "quota" | "off" };
// A refresh starts no run sooner than this after the last run started.
export const REFRESH_MIN_MS = 60_000;

// What the last rate limit says about a run at time t: wait for resetAt ("quota", under LOW_QUOTA), wait for
// SLOW_INTERVAL_MS after the last run ("slow", under SLOW_QUOTA), or null to run. Past resetAt the quota is full again.
export function quotaWait(feed: PrFeed, t: number): { why: "quota" | "slow"; until: number } | null {
  const rl = feed.rate_limit;
  const reset = rl ? Date.parse(rl.resetAt) : NaN;
  if (!rl || !(t < reset)) return null;
  if (rl.remaining < LOW_QUOTA) return { why: "quota", until: reset };
  const next = Date.parse(feed.fetched_at ?? "") + SLOW_INTERVAL_MS;
  if (rl.remaining < SLOW_QUOTA && t < next) return { why: "slow", until: next };
  return null;
}

export type FeedDeps = {
  gh?: Gh;
  repos?: readonly string[];
  initial?: PrFeed;
  now?: () => Date;
  log?: (line: string) => void;
  // Where the last good feed is kept between server runs (read at start, written after each good run); null: none.
  cacheFile?: string | null;
};

export type PrFeedSource = {
  current(): FeedSnapshot;
  subscribe(fn: (snap: FeedSnapshot) => void): () => void;
  // One run, unless one is in flight, a backoff is running, or quotaWait says to wait.
  tick(): Promise<TickResult>;
  // First run now, then every everyMs, or later when a backoff or quotaWait ends later.
  start(everyMs?: number): void;
  // A run now, out of turn (the timer restarts after it), unless the feed is not started ("off"), a run is in flight,
  // the last run started under REFRESH_MIN_MS ago ("debounced"), or a backoff or quotaWait says to wait ("quota").
  // Does not wait for the run; subscribers get its result.
  refresh(): RefreshResult;
  close(): void;
};

export function loadFeedFile(file: string): PrFeed | null {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return isPrFeed(v) ? v : null;
  } catch {
    return null;
  }
}

function saveFeedFile(file: string, feed: PrFeed) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(feed));
  renameSync(tmp, file);
}

// The feed in memory (the source of truth), seeded from the cache file so the page has data right away. A failed
// run keeps the last good prs, sets github.error and backs off; the timer never overlaps runs.
export function createPrFeed(deps: FeedDeps = {}): PrFeedSource {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const cacheFile = deps.cacheFile ?? null;
  const listeners = new Set<(snap: FeedSnapshot) => void>();
  const seed = deps.initial ?? ((cacheFile && loadFeedFile(cacheFile)) || emptyFeed());
  let snap: FeedSnapshot = { feed: seed, json: JSON.stringify(seed) };
  let running = false;
  let failures = 0;
  let notBefore = 0;
  let started = false;
  let everyMs = FEED_INTERVAL_MS;
  let lastStart = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const set = (feed: PrFeed) => {
    const json = JSON.stringify(feed);
    if (json === snap.json) return;
    snap = { feed, json };
    for (const fn of [...listeners]) fn(snap);
  };

  async function tick(): Promise<TickResult> {
    if (running) return "busy";
    const t = now().getTime();
    if (t < notBefore) return "backoff";
    const wait = quotaWait(snap.feed, t);
    if (wait) return wait.why;
    running = true;
    lastStart = t;
    const prev = snap.feed;
    try {
      const g = await fetchPrs(deps.gh ?? githubCli(), deps.repos ?? []);
      const iso = now().toISOString();
      const feed: PrFeed = {
        fetched_at: iso,
        github: { ok: true, login: g.login, error: null, last_ok: iso },
        rate_limit: g.rate_limit,
        prs: g.prs,
      };
      failures = 0;
      notBefore = 0;
      set(feed);
      if (cacheFile) {
        try {
          saveFeedFile(cacheFile, feed);
        } catch (e) {
          log(`pr-feed: could not write ${FEED_FILE}: ${errText(e)}`);
        }
      }
      const r = g.rate_limit;
      log(`pr-feed: ok prs=${g.prs.length} pages=${r.pages} cost=${r.cost} remaining=${r.remaining}`);
      return "ok";
    } catch (e) {
      const error = errText(e);
      failures++;
      notBefore = now().getTime() + BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1];
      set({ ...prev, fetched_at: now().toISOString(), github: { ...prev.github, ok: false, error } });
      log(`pr-feed: error ${error}`);
      return "error";
    } finally {
      running = false;
    }
  }

  // One run, then the next one scheduled. Only one loop waits at a time: a new loop clears the pending timer.
  async function loop() {
    clearTimeout(timer);
    await tick().catch(() => "error");
    if (!started) return;
    const t = now().getTime();
    const wait = quotaWait(snap.feed, t);
    clearTimeout(timer);
    timer = setTimeout(loop, Math.max(everyMs, notBefore - t, wait ? wait.until - t : 0));
    timer.unref?.();
  }

  return {
    current: () => snap,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    tick,
    start(ms = FEED_INTERVAL_MS) {
      if (started) return;
      started = true;
      everyMs = ms;
      void loop();
    },
    refresh() {
      if (!started) return { started: false, reason: "off" };
      if (running) return { started: false, reason: "in-flight" };
      const t = now().getTime();
      if (t - lastStart < REFRESH_MIN_MS) return { started: false, reason: "debounced" };
      if (t < notBefore || quotaWait(snap.feed, t)) return { started: false, reason: "quota" };
      void loop();
      return { started: true };
    },
    close() {
      started = false;
      clearTimeout(timer);
      timer = undefined;
      listeners.clear();
    },
  };
}
