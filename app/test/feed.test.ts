import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKOFF_MS,
  FLEET,
  GH_QUERY,
  LOW_QUOTA,
  MAX_PAGES,
  NOT_HUMAN,
  PAGE_COST,
  REFRESH_MIN_MS,
  searchQuery,
  SLOW_INTERVAL_MS,
  SLOW_QUOTA,
  createPrFeed as makePrFeed,
  errText,
  fetchPrs as fetchConfiguredPrs,
  normalizePr,
  type Gh,
} from "../server/feed";
import fixture from "./fixtures/sample-pr.json";
import { openReasons } from "../src/prFeed";
import { parsePrRepos } from "../src/prRepos";
import { emptyFeed, isPrFeed, type PrFeed } from "../src/feedTypes";

type Json = Record<string, any>;

const REPOS = ["acme/example-api", "acme/example-web"];
const SEARCH_QUERY = searchQuery(REPOS);
const fetchPrs = (gh: Gh) => fetchConfiguredPrs(gh, REPOS);
const createPrFeed = (deps: Parameters<typeof makePrFeed>[0] = {}) => makePrFeed({ repos: REPOS, ...deps });

// A search node as GitHub returns it for the query in server/feed.ts.
const node = (over: Json = {}): Json => ({
  number: 12070,
  title: "Project BE-38b: project reminder notification",
  url: "https://github.com/acme/example-team/pull/12070",
  additions: 120,
  deletions: 8,
  reviewDecision: "REVIEW_REQUIRED",
  createdAt: "2026-11-20T08:30:00Z",
  updatedAt: "2026-11-25T10:00:00Z",
  headRefName: "project/be-38b",
  baseRefName: "project",
  repository: { name: "example-team" },
  author: { login: "alice" },
  labels: { nodes: [{ name: "project", color: "0e8a16" }] },
  totalCommentsCount: 3,
  reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
  ...over,
});

const counts = (state: string, runs: Record<string, number>, statuses: Record<string, number> = {}) => ({
  nodes: [
    {
      commit: {
        statusCheckRollup: {
          state,
          contexts: {
            checkRunCountsByState: Object.entries(runs).map(([s, count]) => ({ state: s, count })),
            statusContextCountsByState: Object.entries(statuses).map(([s, count]) => ({ state: s, count })),
          },
        },
      },
    },
  ],
});

let idSequence = 0;
const thread = (isResolved: boolean, body = "Please rename this.", url = "https://github.com/acme/example-team/pull/12070#discussion_r1") => ({
  id: `thread_${++idSequence}`,
  isResolved,
  comments: { nodes: [{ author: { login: "carol" }, path: "app/x.ts", body, url }] },
});

const withThreads = (threads: Json[], totalCount = threads.length, login = "alice") =>
  normalizePr(
    node({ reviewThreads: { totalCount, nodes: threads.map(({ id, isResolved }) => ({ id, isResolved })) } }),
    login,
    new Map(threads.map((t) => [t.id, t.comments.nodes[0]])),
  );

describe("normalizePr", () => {
  it("maps the fields and sets mine from the viewer login", () => {
    const pr = normalizePr(node(), "alice");
    expect(pr).toEqual({
      link: "https://github.com/acme/example-team/pull/12070",
      repo: "example-team",
      number: 12070,
      title: "Project BE-38b: project reminder notification",
      author: "alice",
      mine: true,
      base: "project",
      head: "project/be-38b",
      review_decision: "REVIEW_REQUIRED",
      head_oid: "",
      reviewers: [],
      ci: "none",
      checks: { passed: 0, failed: 0, pending: 0 },
      failing_checks: 0,
      labels: [{ name: "project", color: "0e8a16" }],
      comments: 3,
      additions: 120,
      deletions: 8,
      unresolved_count: 0,
      unresolved_more: false,
      unresolved: [],
      created_at: "2026-11-20T08:30:00Z",
      updated_at: "2026-11-25T10:00:00Z",
    });
    expect(normalizePr(node(), "someone-else").mine).toBe(false);
    expect(normalizePr(node({ author: null }), "alice")).toMatchObject({ author: "unknown", mine: false });
    expect(normalizePr(node({ reviewDecision: null }), "alice").review_decision).toBeNull();
  });

  it("carries createdAt as created_at, empty when it is missing or not a string", () => {
    expect(normalizePr(node(), "alice").created_at).toBe("2026-11-20T08:30:00Z");
    expect(normalizePr(node({ createdAt: undefined }), "alice").created_at).toBe("");
    expect(normalizePr(node({ createdAt: null }), "alice").created_at).toBe("");
    expect(normalizePr(node({ createdAt: 1700000000 }), "alice").created_at).toBe("");
    expect(GH_QUERY).toMatch(/reviewDecision createdAt updatedAt/);
  });

  it("counts failing checks from the per-state counts across check runs and status contexts", () => {
    const pr = normalizePr(
      node({
        commits: counts(
          "FAILURE",
          { SUCCESS: 5, SKIPPED: 2, NEUTRAL: 1, FAILURE: 1, TIMED_OUT: 1, CANCELLED: 1, ACTION_REQUIRED: 1, STARTUP_FAILURE: 1, IN_PROGRESS: 2, QUEUED: 1 },
          { SUCCESS: 1, ERROR: 1, FAILURE: 1, PENDING: 1, EXPECTED: 1 },
        ),
      }),
      "alice",
    );
    expect(pr.checks).toEqual({ passed: 9, failed: 7, pending: 5 });
    expect(pr.failing_checks).toBe(7);
    expect(pr.ci).toBe("failing");
    expect(normalizePr(node({ commits: counts("SUCCESS", { SUCCESS: 6, SKIPPED: 2 }) }), "alice")).toMatchObject({ ci: "passing", failing_checks: 0, checks: { passed: 8, failed: 0, pending: 0 } });
    expect(normalizePr(node({ commits: counts("PENDING", { SUCCESS: 28, IN_PROGRESS: 1 }) }), "alice")).toMatchObject({ ci: "pending", checks: { passed: 28, failed: 0, pending: 1 } });
    // A failure while others still run is failing, whatever the rollup says.
    expect(normalizePr(node({ commits: counts("PENDING", { FAILURE: 1, IN_PROGRESS: 1 }) }), "alice").ci).toBe("failing");
  });

  it("falls back to the context nodes when the counts are missing", () => {
    const roll = {
      state: "FAILURE",
      contexts: {
        nodes: [
          { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "TIMED_OUT" },
          { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "STARTUP_FAILURE" },
          { __typename: "CheckRun", name: "deploy", status: "IN_PROGRESS", conclusion: null },
          { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" },
          { __typename: "StatusContext", context: "ci/ok", state: "SUCCESS" },
          { __typename: "StatusContext", context: "ci/wait", state: "PENDING" },
        ],
      },
    };
    const pr = normalizePr(node({ commits: { nodes: [{ commit: { statusCheckRollup: roll } }] } }), "alice");
    expect(pr.checks).toEqual({ passed: 3, failed: 3, pending: 2 });
    expect(pr.failing_checks).toBe(3);
    expect(pr.ci).toBe("failing");
  });

  it("lists all fetched open threads, cuts bodies to 400 and keeps only github.com URLs", () => {
    const threads = [
      thread(true, "resolved"),
      thread(false, "x".repeat(1000)),
      thread(false, "evil", "javascript:alert(1)"),
      thread(false, "http", "http://github.com/acme/example-team/pull/12070#x"),
      ...Array.from({ length: 10 }, (_, i) => thread(false, `open ${i}`)),
      { id: "empty", isResolved: false, comments: { nodes: [] } },
    ];
    const pr = withThreads(threads);
    // The thread with no comment has nothing to show, so it is not counted.
    expect(pr.unresolved_count).toBe(13);
    expect(pr.unresolved_more).toBe(false);
    expect(pr.unresolved).toHaveLength(13);
    expect(pr.unresolved[0]).toEqual({ author: "carol", path: "app/x.ts", body: "x".repeat(400), url: "https://github.com/acme/example-team/pull/12070#discussion_r1" });
    expect(pr.unresolved[1].url).toBe("");
    expect(pr.unresolved[2].url).toBe("");
    expect(pr.unresolved.map((t) => t.body).slice(3)).toEqual(Array.from({ length: 10 }, (_, i) => `open ${i}`));
    expect(normalizePr(node({ url: "https://evil.example/pull/1" }), "alice").link).toBe("");
  });

  it("uses GitHub’s total comment count and keeps no PR description", () => {
    const pr = normalizePr(node({ totalCommentsCount: 9, comments: { totalCount: 4 }, body: "b".repeat(7000) }), "alice");
    expect(pr.comments).toBe(9);
    expect("body" in pr).toBe(false);
  });

  it("counts human open threads only, newest first, and flags more threads than were fetched", () => {
    const at = (iso: string, login: string, body: string, __typename = "User") => ({
      id: `thread_${++idSequence}`,
      isResolved: false,
      comments: { totalCount: 1, nodes: [{ author: { login, __typename }, path: "a.ts", body, url: "https://github.com/acme/example-team/pull/12070#r", createdAt: iso }] },
    });
    const threads = [
      at("2026-11-20T10:00:00Z", "Dana", "oldest human"),
      at("2026-11-25T10:00:00Z", "cursor[bot]", "bot"),
      at("2026-11-24T10:00:00Z", "Bob", "newest human"),
      { ...at("2026-11-26T10:00:00Z", "Bob", "resolved"), isResolved: true },
      at("2026-11-23T10:00:00Z", "alice", "Looks fine.\n\n— Assistant"),
    ];
    const pr = withThreads(threads, 14, "alice");
    expect(pr.unresolved.map((t) => t.body)).toEqual(["newest human", "oldest human"]);
    expect(pr.unresolved_count).toBe(2);
    expect(pr.unresolved_more).toBe(true);
    expect(withThreads(threads, 5, "alice").unresolved_more).toBe(false);
  });
});

describe("human review authors", () => {
  const t = (login: string | null, body: string, __typename = "User") => ({
    id: `thread_${++idSequence}`, isResolved: false,
    comments: { nodes: [{ author: login === null ? null : { login, __typename }, body }] },
  });
  const kept = (...threads: Json[]) => withThreads(threads, threads.length, "alice").unresolved.map((x) => x.body);

  it("drops Bot accounts, [bot] logins and the tool denylist, in any case", () => {
    expect(kept(t("cursor", "a", "Bot"), t("some-app", "b", "Bot"), t("cursor[bot]", "c"), t("github-actions", "d"))).toEqual([]);
    for (const login of NOT_HUMAN) expect(kept(t(login.toUpperCase(), "x"))).toEqual([]);
    expect(NOT_HUMAN).toContain("linear-code");
  });

  it("drops the viewer's fleet-signed comments and keeps identical text from other users", () => {
    expect(FLEET).toEqual(["Assistant", "Test Helper", "Build Helper", "Review Bot", "Docs Helper", "Review Helper"]);
    const signed = [
      "[Review Bot] The migration needs an index.",
      "Review Bot: please rename this.",
      "**Review Bot** rename this",
      "**Build Helper:** blocking",
      "— Assistant here: check the permissions",
      "-- Assistant. Check the null case",
      "– Test Helper: ok",
      "  [Review Helper] nit  ",
      "This needs a test.\n\n— Assistant",
      "This needs a test.\n-- Docs Helper",
      "Rename it.\n– Review Helper\n",
    ];
    for (const body of signed) {
      expect(kept(t("alice", body))).toEqual([]);
      expect(kept(t("carol", body))).toEqual([body]);
    }
  });

  it("keeps unsigned viewer comments and comments with a deleted author", () => {
    const human = [
      "Please rename this.",
      "I asked Review Bot about this and she agreed.",
      "Assistant of these calls can go.",
      "Assistanted: too many retries",
      "Thanks — Assistant fixed it yesterday",
      "Review Botope: nope",
    ];
    expect(kept(...human.map((b) => t("alice", b)))).toEqual(human);
    expect(kept(t(null, "ghost account"))).toEqual(["ghost account"]);
  });

  it("keeps sample review bodies from multiple human authors", () => {
    for (const login of ["bob", "carol", "dana", "eli"]) {
      const body = "Please add a test for the empty response.";
      const review = { author: { login, __typename: "User" }, body, state: "COMMENTED" };
      expect(kept(t(login, body))).toEqual([body]);
      expect(normalizePr(node({ latestReviews: { nodes: [review] } }), "alice").reviewers[0].login).toBe(login);
    }
  });
});

describe("reviewers", () => {
  const login = "bob";
  const at = "2026-11-25T12:00:00Z";
  const headRefOid = "1111111111111111111111111111111111111111";
  const review = (state: string, oid = "3333333333333333333333333333333333333333", author = login, body = "") =>
    ({ author: { login: author, __typename: "User" }, state, submittedAt: at, commit: { oid }, body });
  const request = (login: string, __typename = "User") => ({ requestedReviewer: { __typename, login } });

  it("keeps a standing change request on an older head after a comment or another reviewer's request", () => {
    const pr = normalizePr(node({
      headRefOid,
      latestOpinionatedReviews: { nodes: [review("CHANGES_REQUESTED")] },
      latestReviews: { nodes: [review("COMMENTED", headRefOid)] },
      reviewRequests: { nodes: [request("eli"), request("cursor"), request("alice"), request("team", "Team")] },
    }), "alice");
    expect(pr.reviewers).toEqual([
      { login: "eli", state: "REQUESTED", at: "", commit: "", on_head: false, requested: true },
      { login, state: "CHANGES_REQUESTED", at, commit: "33333333", on_head: false, requested: false },
    ]);
    expect(openReasons(pr)).toEqual(["changes requested by bob · pushed since, not re-requested"]);
  });

  it.each(["APPROVED", "DISMISSED"])("replaces the standing change request when the reviewer becomes %s", (state) => {
    const pr = normalizePr(node({
      headRefOid,
      reviewDecision: "CHANGES_REQUESTED",
      latestOpinionatedReviews: { nodes: [review(state, headRefOid)] },
      latestReviews: { nodes: [review("CHANGES_REQUESTED")] },
    }), "alice");
    expect(pr.reviewers).toEqual([{ login, state, at, commit: "11111111", on_head: true, requested: false }]);
    expect(openReasons(pr)).toEqual([]);
  });

  it("filters fleet-signed reviews on the viewer's account and keeps signed-looking bodies from other reviewers", () => {
    const signed = review("APPROVED", headRefOid, "alice", "Review Bot: Looks good.");
    const { body: _, ...opinionated } = signed;
    const pr = normalizePr(node({
      latestOpinionatedReviews: { nodes: [opinionated] },
      latestReviews: { nodes: [signed, review("COMMENTED", headRefOid, "carol", signed.body), review("APPROVED", headRefOid, "alice")] },
    }), "alice");
    expect(pr.reviewers.map((r) => r.login)).toEqual(["carol"]);
  });
});

const page = (nodes: Json[], hasNextPage: boolean, endCursor: string | null, rl: Json = { cost: 1, remaining: 4000, limit: 5000, resetAt: "2026-11-26T21:00:00Z" }) =>
  JSON.stringify({ data: { viewer: { login: "alice" }, rateLimit: rl, search: { pageInfo: { hasNextPage, endCursor }, nodes } } });

describe("fetchPrs", () => {
  it("normalizes configured repos and makes no CLI request when none are valid", async () => {
    expect(parsePrRepos(" ACME/EXAMPLE-API, acme/example-api, invalid, acme/example-web "))
      .toEqual(["acme/example-api", "acme/example-web"]);
    const failIfCalled: Gh = async () => { throw new Error("GitHub should not be called"); };
    await expect(fetchConfiguredPrs(failIfCalled, parsePrRepos("invalid"))).rejects.toThrow("No GitHub repositories configured");
  });

  it("pages with the cursor until hasNextPage is false, sums the cost and keeps the last remaining", async () => {
    const calls: string[][] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      return args.includes("cursor=c1")
        ? page([node({ number: 2, url: "https://github.com/acme/a/pull/2", author: { login: "carol" }, updatedAt: "2026-11-26T09:00:00Z" })], false, "c2", { cost: 2, remaining: 3997, limit: 5000, resetAt: "2026-11-26T21:00:00Z" })
        : page([node({ number: 1, url: "https://github.com/acme/a/pull/1" }), { }], true, "c1");
    };
    const r = await fetchPrs(gh);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["api", "graphql", "-f", `query=${GH_QUERY}`, "-f", `q=${SEARCH_QUERY}`]);
    expect(calls[1].slice(-2)).toEqual(["-f", "cursor=c1"]);
    expect(SEARCH_QUERY).toBe("repo:acme/example-api repo:acme/example-web is:pr is:open archived:false involves:@me");
    expect(GH_QUERY).toMatch(/viewer \{ login \}/);
    expect(GH_QUERY).toMatch(/rateLimit \{ cost remaining limit resetAt \}/);
    expect(GH_QUERY).toMatch(/first: 25, after: \$cursor/);
    expect(r.login).toBe("alice");
    expect(r.rate_limit).toEqual({ cost: 3, remaining: 3997, limit: 5000, resetAt: "2026-11-26T21:00:00Z", pages: 2 });
    expect(r.prs.map((p) => [p.number, p.mine])).toEqual([
      [2, false],
      [1, true],
    ]);
  });

  it("asks for seven connections per PR, with no nested thread comments", () => {
    expect(GH_QUERY).toMatch(/\bheadRefOid\b/);
    expect(GH_QUERY).toMatch(/reviewThreads\(last: 100\) \{ totalCount nodes \{ id isResolved \} \}/);
    expect(GH_QUERY).toMatch(/labels\(first: 8\)/);
    expect(GH_QUERY).toMatch(/contexts\(first: 1\)/);
    expect(GH_QUERY).toContain("reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } } } }");
    expect(GH_QUERY).toContain("latestReviews(first: 20) { nodes { author { login __typename } state submittedAt commit { oid } body } }");
    expect(GH_QUERY).toContain("latestOpinionatedReviews(first: 20) { nodes { author { login __typename } state submittedAt commit { oid } } }");
    expect(GH_QUERY).toContain("totalCommentsCount");
    for (const gone of ["reviews", "timelineItems", "comments", "pushedDate", "mergeable", "isDraft", "changedFiles", "isOutdated"]) {
      expect(GH_QUERY).not.toMatch(new RegExp(`\\b${gone}\\b`));
    }
    expect(GH_QUERY.match(/\bbody\b/g)).toHaveLength(1);
    const firsts = [...GH_QUERY.matchAll(/\b(?:first|last): (\d+)/g)].map((m) => Number(m[1]));
    expect(firsts).toEqual([25, 8, 10, 20, 20, 100, 1, 1]);
    expect(1 + 25 * 7).toBe(176);
    expect(PAGE_COST).toBe(2);
  });

  it("recovers #731's standing change request and its 29th thread", async () => {
    const calls: string[] = [];
    const r = await fetchPrs(async (args) => {
      calls.push(args[3]);
      return calls.length === 1
        ? JSON.stringify({ data: {
            viewer: fixture.viewer,
            search: { nodes: [fixture.pullRequest], pageInfo: { hasNextPage: false } },
            rateLimit: { cost: 2, remaining: 2359 },
          } })
        : JSON.stringify({ data: { nodes: fixture.threadNodes, rateLimit: { cost: 2, remaining: 2357 } } });
    });
    expect(fixture.pullRequest.reviewThreads.nodes).toHaveLength(29);
    expect(calls).toHaveLength(2);
    const first = fixture.threadNodes[0].comments.nodes[0];
    expect(first.databaseId).toBe(501);
    expect(calls[1]).toContain(`nodes(ids: ["${fixture.threadNodes[0].id}"])`);
    expect(r.rate_limit).toMatchObject({ cost: 4, remaining: 2357, pages: 1 });
    const [pr] = r.prs;
    expect(pr.head_oid).toBe(fixture.pullRequest.headRefOid);
    expect(pr.reviewers).toEqual(expect.arrayContaining([
      { login: "bob", state: "CHANGES_REQUESTED", at: "2026-11-25T22:19:46Z", commit: "33333333", on_head: false, requested: true },
      { login: "carol", state: "COMMENTED", at: "2026-11-26T21:20:37Z", commit: "11111111", on_head: true, requested: false },
      { login: "dana", state: "APPROVED", at: "2026-11-26T19:56:12Z", commit: "11111111", on_head: true, requested: false },
    ]));
    expect(pr.reviewers).toHaveLength(3);
    expect(pr).toMatchObject({ comments: 87, unresolved_count: 1, unresolved_more: false, unresolved: [
      { author: "carol", body: first.body, path: first.path, url: first.url },
    ] });
    expect(openReasons(pr)).toEqual(["changes requested by bob · re-review requested", "1 open thread"]);
  });

  it("batches validated open IDs across all pages at 100, stops at five batches and sums actual costs", async () => {
    const batches: string[][] = [];
    const prs = Array.from({ length: 6 }, (_, i) => node({
      number: i + 1,
      url: `https://github.com/acme/r/pull/${i + 1}`,
      reviewThreads: { totalCount: 100, nodes: Array.from({ length: 100 }, (_, j) =>
        ({ id: `thread_${i}_${j}`, isResolved: i === 0 && j === 0 })) },
    }));
    prs[0].reviewThreads.nodes[1].id = 'unsafe"}';
    const r = await fetchPrs(async (args) => {
      if (args.includes(`q=${SEARCH_QUERY}`)) {
        return args.includes("cursor=c1") ? page(prs.slice(3), false, null) : page(prs.slice(0, 3), true, "c1");
      }
      const ids: string[] = JSON.parse(args[3].match(/nodes\(ids: (\[[^\]]*\])/)![1]);
      expect(batches.length).toBeLessThan(5);
      batches.push(ids);
      expect(args[3]).toContain("id comments(first: 1) { nodes { author { login __typename } path body url createdAt } }");
      return JSON.stringify({ data: {
        rateLimit: { cost: 2, remaining: 4000 - batches.length * 2, limit: 5000, resetAt: "later" },
        nodes: ids.map((id) => ({ id, comments: { nodes: [{ author: { login: "carol" }, body: id }] } })),
      } });
    });
    expect(batches.map((b) => b.length)).toEqual([100, 100, 100, 100, 100]);
    expect(batches.flat().slice(0, 2)).toEqual(["thread_0_2", "thread_0_3"]);
    expect(batches.flat().at(-1)).toBe("thread_5_1");
    expect(r.rate_limit).toEqual({ cost: 12, remaining: 3990, limit: 5000, resetAt: "later", pages: 2 });
    expect(r.prs.map((p) => [p.unresolved_count, p.unresolved_more])).toEqual([
      [98, true], [100, false], [100, false], [100, false], [100, false], [2, true],
    ]);
  });

  it("uses a smaller final batch with the remaining open IDs", async () => {
    const batches: number[] = [];
    let pages = 0;
    const r = await fetchPrs(async (args) => {
      if (args.includes(`q=${SEARCH_QUERY}`)) {
        const length = pages++ === 0 ? 100 : 1;
        return page([node({ number: pages, url: `https://github.com/acme/r/pull/${pages}`, reviewThreads: {
          nodes: Array.from({ length }, (_, i) => ({ id: `thread_${pages}_${i}`, isResolved: false })),
        } })], pages === 1, "c");
      }
      const ids: string[] = JSON.parse(args[3].match(/nodes\(ids: (\[[^\]]*\])/)![1]);
      batches.push(ids.length);
      return JSON.stringify({ data: {
        rateLimit: { cost: 1, remaining: 4000 - batches.length },
        nodes: ids.map((id) => ({ id, comments: { nodes: [] } })),
      } });
    });
    expect(batches).toEqual([100, 1]);
    expect(r.rate_limit).toMatchObject({ cost: 4, remaining: 3998, pages: 2 });
    expect(r.prs.every((p) => !p.unresolved_more)).toBe(true);
  });

  it(`stops after ${MAX_PAGES} pages`, async () => {
    let n = 0;
    const r = await fetchPrs(async () => page([node({ number: ++n, url: `https://github.com/acme/a/pull/${n}` })], true, `c${n}`));
    expect(n).toBe(MAX_PAGES);
    expect(r.rate_limit.pages).toBe(MAX_PAGES);
    expect(r.prs).toHaveLength(MAX_PAGES);
  });

  it("throws the first GraphQL error when there is no data", async () => {
    await expect(fetchPrs(async () => JSON.stringify({ errors: [{ message: "Something went wrong\nmore" }] }))).rejects.toThrow("GitHub GraphQL: Something went wrong");
  });
});

describe("errText", () => {
  it("keeps the first line and blanks token-shaped text", () => {
    expect(errText(new Error("bad credentials ghp_abcDEF123456 for you\nsecond line"))).toBe("bad credentials [token] for you");
  });
});

describe("createPrFeed", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const clock = (iso = "2026-11-26T12:00:00.000Z") => {
    let t = Date.parse(iso);
    return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
  };

  it("logs one ok line, persists the good feed in one atomic replace and serves it to subscribers", async () => {
    dir = mkdtempSync(join(tmpdir(), "ab-feed-"));
    const cacheFile = join(dir, ".pr-feed.json");
    const lines: string[] = [];
    const c = clock();
    const gh: Gh = async (args) => (args.includes("cursor=c1") ? page([node({ number: 2, url: "https://github.com/acme/a/pull/2" })], false, null, { cost: 1, remaining: 3998, limit: 5000, resetAt: "2026-11-26T13:00:00Z" }) : page([node()], true, "c1"));
    const feed = createPrFeed({ gh, now: c.now, log: (l) => lines.push(l), cacheFile });
    expect(feed.current().feed).toEqual(emptyFeed());
    const seen: PrFeed[] = [];
    feed.subscribe((s) => seen.push(s.feed));
    expect(await feed.tick()).toBe("ok");
    expect(lines).toEqual(["pr-feed: ok prs=2 pages=2 cost=2 remaining=3998"]);
    expect(seen).toHaveLength(1);
    const f = feed.current().feed;
    expect(f).toMatchObject({ fetched_at: "2026-11-26T12:00:00.000Z", github: { ok: true, login: "alice", error: null, last_ok: "2026-11-26T12:00:00.000Z" }, rate_limit: { cost: 2, pages: 2 } });
    expect(feed.current().json).toBe(JSON.stringify(f));
    expect(JSON.parse(readFileSync(cacheFile, "utf8"))).toEqual(f);

    // A new server starts from the cache file.
    const again = createPrFeed({ gh: async () => { throw new Error("not called"); }, cacheFile });
    expect(again.current().feed).toEqual(f);
    expect(f.prs[0].created_at).toBe("2026-11-20T08:30:00Z");
    // An older cache file, written before created_at, still loads.
    const older = { ...f, prs: f.prs.map(({ created_at: _, ...p }) => p) };
    writeFileSync(cacheFile, JSON.stringify(older));
    expect(createPrFeed({ cacheFile }).current().feed).toEqual(older);
    // A bad cache file is ignored.
    writeFileSync(cacheFile, "{nope");
    expect(createPrFeed({ cacheFile }).current().feed).toEqual(emptyFeed());
  });

  it("on error keeps the last good prs, sets github.error and backs off 2, 4, 8, 16, 30, 30 minutes; a good run resets it", async () => {
    const lines: string[] = [];
    const c = clock();
    let fail = false;
    const gh: Gh = async () => {
      if (fail) throw new Error("HTTP 502: Bad Gateway (https://api.github.com/graphql)\nsecond line");
      return page([node()], false, null);
    };
    const feed = createPrFeed({ gh, now: c.now, log: (l) => lines.push(l) });
    await feed.tick();
    const good = feed.current().feed;
    fail = true;
    expect(await feed.tick()).toBe("error");
    expect(lines.at(-1)).toBe("pr-feed: error HTTP 502: Bad Gateway (https://api.github.com/graphql)");
    const bad = feed.current().feed;
    expect(bad.prs).toEqual(good.prs);
    expect(bad.rate_limit).toEqual(good.rate_limit);
    expect(bad.github).toEqual({ ok: false, login: "alice", error: "HTTP 502: Bad Gateway (https://api.github.com/graphql)", last_ok: good.github.last_ok });

    const waits = [];
    for (const ms of BACKOFF_MS.concat(BACKOFF_MS.at(-1)!)) {
      c.advance(ms - 1000);
      expect(await feed.tick()).toBe("backoff");
      c.advance(1000);
      expect(await feed.tick()).toBe("error");
      waits.push(ms / 60_000);
    }
    expect(waits).toEqual([2, 4, 8, 16, 30, 30]);
    fail = false;
    c.advance(30 * 60_000);
    expect(await feed.tick()).toBe("ok");
    expect(feed.current().feed.github).toMatchObject({ ok: true, error: null });
    expect(await feed.tick()).toBe("ok");
  });

  it("keeps the last good feed and backs off when the thread lookup fails", async () => {
    const c = clock();
    let fail = false;
    const source = createPrFeed({
      now: c.now,
      log: () => {},
      gh: async (args) => {
        if (args.includes(`q=${SEARCH_QUERY}`)) {
          return page([node({ title: fail ? "New title" : "Last good title", reviewThreads: { nodes: [{ id: "thread_1", isResolved: false }] } })], false, null);
        }
        const data = { nodes: [{ id: "thread_1", comments: { nodes: [{ author: { login: "carol" }, body: "Keep this" }] } }], rateLimit: { cost: 2, remaining: 3998 } };
        return JSON.stringify(fail ? { data, errors: [{ message: "Thread lookup failed" }] } : { data });
      },
    });
    expect(await source.tick()).toBe("ok");
    const good = source.current().feed;
    expect(good.prs[0].unresolved_count).toBe(1);
    fail = true;
    expect(await source.tick()).toBe("error");
    expect(source.current().feed).toMatchObject({
      prs: good.prs, rate_limit: good.rate_limit,
      github: { ok: false, last_ok: good.github.last_ok, error: "GitHub GraphQL review threads: Thread lookup failed" },
    });
    expect(await source.tick()).toBe("backoff");
  });

  it("skips a tick while one is in flight", async () => {
    let release!: () => void;
    let calls = 0;
    const gh: Gh = () => {
      calls++;
      return new Promise((resolve) => (release = () => resolve(page([node()], false, null))));
    };
    const feed = createPrFeed({ gh, log: () => {} });
    const first = feed.tick();
    expect(await feed.tick()).toBe("busy");
    release();
    expect(await first).toBe("ok");
    expect(calls).toBe(1);
  });

  it(`skips until resetAt while fewer than ${LOW_QUOTA} points remain`, async () => {
    const c = clock("2026-11-26T12:00:00.000Z");
    let calls = 0;
    const gh: Gh = async () => (calls++, page([node()], false, null, { cost: 1, remaining: LOW_QUOTA - 1, limit: 5000, resetAt: "2026-11-26T12:30:00Z" }));
    const feed = createPrFeed({ gh, now: c.now, log: () => {} });
    expect(await feed.tick()).toBe("ok");
    c.advance(20 * 60_000);
    expect(await feed.tick()).toBe("quota");
    c.advance(10 * 60_000);
    expect(await feed.tick()).toBe("ok");
    expect(calls).toBe(2);
  });

  it(`under ${SLOW_QUOTA} points runs at most every 6 minutes until resetAt; at ${SLOW_QUOTA} or more every tick runs`, async () => {
    const c = clock("2026-11-26T12:00:00.000Z");
    let remaining = SLOW_QUOTA - 1;
    let resetAt = "2026-11-26T12:20:00Z";
    let calls = 0;
    const gh: Gh = async () => (calls++, page([node()], false, null, { cost: 4, remaining, limit: 5000, resetAt }));
    const feed = createPrFeed({ gh, now: c.now, log: () => {} });
    expect(await feed.tick()).toBe("ok");
    expect(SLOW_INTERVAL_MS).toBe(6 * 60_000);
    c.advance(2 * 60_000);
    expect(await feed.tick()).toBe("slow");
    c.advance(4 * 60_000 - 1);
    expect(await feed.tick()).toBe("slow");
    c.advance(1);
    expect(await feed.tick()).toBe("ok");
    expect(calls).toBe(2);
    // Past resetAt (12:20) the quota is full again: no stretch.
    c.advance(15 * 60_000);
    expect(await feed.tick()).toBe("ok");
    c.advance(1000);
    // Before resetAt again, but with SLOW_QUOTA points left.
    resetAt = "2026-11-26T13:20:00Z";
    remaining = SLOW_QUOTA;
    expect(await feed.tick()).toBe("ok");
    c.advance(1000);
    expect(await feed.tick()).toBe("ok");
    expect(calls).toBe(5);
  });

  it("start waits out the stretched interval instead of ticking every interval", async () => {
    let calls = 0;
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    const feed = createPrFeed({ gh: async () => (calls++, page([], false, null, { cost: 4, remaining: SLOW_QUOTA - 1, limit: 5000, resetAt })), log: () => {} });
    feed.start(20);
    await new Promise((r) => setTimeout(r, 120));
    feed.close();
    expect(calls).toBe(1);
  });

  it("refresh: off until started, skipped while in flight, within 60 s of the last start, or under the quota guard", async () => {
    const c = clock("2026-11-26T12:00:00.000Z");
    let release: (() => void) | undefined;
    let remaining = 4000;
    let calls = 0;
    const gh: Gh = () => {
      calls++;
      return new Promise((resolve) => (release = () => resolve(page([node()], false, null, { cost: 5, remaining, limit: 5000, resetAt: "2026-11-26T13:00:00Z" }))));
    };
    const settle = async () => {
      release?.();
      release = undefined;
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    const feed = createPrFeed({ gh, now: c.now, log: () => {} });
    expect(feed.refresh()).toEqual({ started: false, reason: "off" });
    expect(calls).toBe(0);
    feed.start(3_600_000);
    expect(calls).toBe(1);
    expect(feed.refresh()).toEqual({ started: false, reason: "in-flight" });
    await settle();
    expect(REFRESH_MIN_MS).toBe(60_000);
    c.advance(59_999);
    expect(feed.refresh()).toEqual({ started: false, reason: "debounced" });
    c.advance(1);
    expect(feed.refresh()).toEqual({ started: true });
    expect(calls).toBe(2);
    remaining = SLOW_QUOTA - 1;
    await settle();
    c.advance(REFRESH_MIN_MS);
    // Under SLOW_QUOTA a run waits 6 minutes after the last one.
    expect(feed.refresh()).toEqual({ started: false, reason: "quota" });
    expect(calls).toBe(2);
    c.advance(SLOW_INTERVAL_MS);
    expect(feed.refresh()).toEqual({ started: true });
    expect(calls).toBe(3);
    await settle();
    feed.close();
  });

  it("start runs at once and then on the interval", async () => {
    let calls = 0;
    const feed = createPrFeed({ gh: async () => (calls++, page([], false, null)), log: () => {} });
    feed.start(30);
    await new Promise((r) => setTimeout(r, 100));
    feed.close();
    expect(calls).toBeGreaterThanOrEqual(2);
    const after = calls;
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(after);
  });
});

describe("isPrFeed", () => {
  it("accepts a feed and refuses other shapes", () => {
    expect(isPrFeed(emptyFeed())).toBe(true);
    expect(isPrFeed({ ...emptyFeed(), prs: [normalizePr(node(), "alice")] })).toBe(true);
    expect(isPrFeed({ ...emptyFeed(), prs: [{ link: 1 }] })).toBe(false);
    expect(isPrFeed({ prs: [] })).toBe(false);
    expect(isPrFeed(null)).toBe(false);
  });
});
