import { describe, expect, it } from "vitest";
import type { Board, OtherPR, WaitingItem } from "../src/data/types";
import type { PrFeedItem } from "../src/feedTypes";
import { feedByLink } from "../src/prFeed";
import {
  classifyPr,
  isReviewRequest,
  MAIN_REPOS,
  otherRepoOf,
  PR_ORIGIN_LABEL,
  PR_SECTIONS,
  prSections,
  sortPrRows,
  type PrRow,
} from "../src/prs";
import { feedPr } from "./feed-pr";

const BE = "https://github.com/acme/example-api/pull/";
const FE = "https://github.com/acme/example-web/pull/";
const ADA = "https://github.com/acme/example-tools/pull/";
const CRM = "https://github.com/acme/crm/pull/";

describe("classifyPr", () => {
  it("files every PR outside example-api and example-web under Other repos, whatever its branches or title", () => {
    expect(MAIN_REPOS).toEqual(["acme/example-api", "acme/example-web"]);
    expect(classifyPr({ base: "main", link: `${CRM}57` })).toBe("other_repos");
    expect(classifyPr({ base: "main", head: "hotfix/x", link: `${CRM}58` })).toBe("other_repos");
    expect(classifyPr({ title: "HotFix! login", base: "main", repo: "crm" })).toBe("other_repos");
    expect(classifyPr({ base: "project", repo: "crm" })).toBe("other_repos");
    expect(classifyPr({ title: "Project BE-38b: x", link: `${CRM}59` })).toBe("other_repos");
    expect(classifyPr({ head: "hotfix/x", repo: "example-tools" })).toBe("other_repos");
    expect(classifyPr({ base: "master", repo: "crm" })).toBe("other_repos");
    // The feed's repo wins over the link's.
    expect(classifyPr({ base: "main", repo: "crm", link: `${BE}1` })).toBe("other_repos");
    expect(classifyPr({ base: "main", repo: "example-api", link: `${CRM}1` })).toBe("hotfix");
  });

  it("files example-tools #7 and crm #57 (base main) under Other repos", () => {
    const ada = { base: "main", head: "feature/redact-log-fields", title: "Redact secrets from build logs", link: `${ADA}7` };
    expect(classifyPr(ada)).toBe("other_repos");
    expect(classifyPr({ ...ada, repo: "example-tools" })).toBe("other_repos");
    expect(classifyPr({ base: "main", title: "CRM change", link: `${CRM}57` })).toBe("other_repos");
  });

  it("treats an unknown repo as example-api or example-web", () => {
    expect(classifyPr({ base: "main" })).toBe("hotfix");
    expect(classifyPr({ base: "dev", link: "https://example.com/pr/1" })).toBe("other");
    expect(classifyPr({ title: "Project BE-38b: x" })).toBe("project");
  });

  it("in example-api and example-web, files base main, master, release-* and hotfix* as hotfixes", () => {
    for (const base of ["master", "main", " Main ", "release-2026-11", "release-1.4", "hotfix", "hotfix/1.2", "hot-fix-nov"]) {
      expect([base, classifyPr({ base, link: `${BE}1` })]).toEqual([base, "hotfix"]);
      expect([base, classifyPr({ base, repo: "example-web" })]).toEqual([base, "hotfix"]);
    }
    expect(classifyPr({ base: "main", title: "Fix login", link: `${BE}2001` })).toBe("hotfix");
    expect(classifyPr({ base: "master", link: `${FE}1700` })).toBe("hotfix");
    // The feed's repo, else the link's; any case.
    expect(classifyPr({ base: "main", repo: "example-api" })).toBe("hotfix");
    expect(classifyPr({ base: "main", link: "https://github.com/acme/example-web/pull/9/" })).toBe("hotfix");
  });

  it("files head hotfix/* and hot-fix/* as hotfixes, whatever the base", () => {
    expect(classifyPr({ head: "hotfix/project-tax", base: "project" })).toBe("hotfix");
    expect(classifyPr({ head: "hot-fix/login", base: "develop", repo: "example-api" })).toBe("hotfix");
    // Only as a prefix.
    expect(classifyPr({ head: "feature/hotfix/x" })).toBe("other");
  });

  it("never files by title: HotFix! alone is not a hotfix", () => {
    expect(classifyPr({ title: "HotFix! Project totals off by a cent", link: `${BE}3` })).toBe("other");
    expect(classifyPr({ title: "HotFix! tax rounding", base: "dev", link: `${BE}4` })).toBe("other");
    expect(classifyPr({ title: "hotfix! login", base: "project" })).toBe("project");
  });

  it("files base project as project; hotfix rules win over it", () => {
    expect(classifyPr({ base: "project", head: "PROJ-15231-api", repo: "example-api" })).toBe("project");
    expect(classifyPr({ base: "project", head: "hotfix/x" })).toBe("hotfix");
  });

  it("keeps #731 (example-api, base dev, HOT) in Non-project", () => {
    expect(classifyPr({ base: "dev", repo: "example-api", title: "Summarize build alerts (#731)", link: `${BE}731`, hot: true })).toBe("other");
  });

  it("files live entries with no base or head by title: \"Project <ticket>\" at the start means project", () => {
    expect(classifyPr({ title: "Project BE-38b: project reminder notification (#12070)", link: `${BE}12070` })).toBe("project");
    expect(classifyPr({ title: "Project FE-22a: submit this project (frontend #11769)" })).toBe("project");
    expect(classifyPr({ title: "Project QA-01o: ..." })).toBe("project");
    expect(classifyPr({ title: "  project be-38b: lower case" })).toBe("project");
    // Mentioning project is not enough.
    expect(classifyPr({ base: "develop", head: "feature/x", title: "Project banner moves up" })).toBe("other");
    expect(classifyPr({ title: "Fix project rounding (#1234)" })).toBe("other");
    expect(classifyPr({ title: "Projects and projecting" })).toBe("other");
    expect(classifyPr({ title: "Project: BE-38b" })).toBe("other");
  });

  it("files a head starting project/ as project", () => {
    expect(classifyPr({ head: "project/PROJ-15300-api", title: "API sync" })).toBe("project");
    expect(classifyPr({ head: " Project/x" })).toBe("project");
    expect(classifyPr({ head: "PROJ-15300-Project-tax", title: "Tax tiers" })).toBe("other");
  });

  it("files a base project row with a neutral title as project", () => {
    expect(classifyPr({ base: "project", title: "Seed tax tiers (#11800)" })).toBe("project");
  });

  it("uses the head and title project rules only when no base is known", () => {
    expect(classifyPr({ base: "dev", title: "Project BE-38b: project reminder notification (#12070)" })).toBe("other");
    expect(classifyPr({ base: "dev", head: "project/PROJ-1" })).toBe("other");
    expect(classifyPr({ base: "  ", title: "Project BE-38b: x" })).toBe("project");
  });

  it("distinguishes owners when repositories share the same name", () => {
    expect(classifyPr({ link: "https://github.com/acme/example-api/pull/42", base: "main" })).toBe("hotfix");
    expect(classifyPr({ link: "https://github.com/example-org/example-api/pull/42", base: "main" })).toBe("other_repos");
  });

  it("lets hotfix win over every project rule", () => {
    expect(classifyPr({ base: "master", title: "Fix login redirect", repo: "example-api" })).toBe("hotfix");
    expect(classifyPr({ base: "master", title: "Project BE-38b: project reminder notification (#12070)", repo: "example-api" })).toBe("hotfix");
    expect(classifyPr({ head: "hotfix/project-x", title: "Project BE-40a: totals" })).toBe("hotfix");
  });

  it("files everything else, and items with no branch or title signal, as non-project", () => {
    expect(classifyPr({ title: "Site-wide single-term search (#11956)", link: `${FE}11956` })).toBe("other");
    expect(classifyPr({ base: "develop", head: "feature/x", title: "Banner" })).toBe("other");
    expect(classifyPr({ base: "project-v2" })).toBe("other");
    expect(classifyPr({ base: "mainline" })).toBe("other");
    expect(classifyPr({})).toBe("other");
  });

  it("ignores case and surrounding whitespace on branch names", () => {
    expect(classifyPr({ base: "  MAIN ", repo: "example-api" })).toBe("hotfix");
    expect(classifyPr({ base: "Release-9", repo: "example-web" })).toBe("hotfix");
    expect(classifyPr({ head: " HotFix/abc" })).toBe("hotfix");
    expect(classifyPr({ base: " Project\t" })).toBe("project");
  });
});

describe("isReviewRequest", () => {
  const other = (author: string): PrRow => ({ origin: "others", item: { title: "T", author, who: "Your review requested", link: `${BE}11978` } });
  it("is true when someone other than the login authored the PR: the feed's author first, else the glance.others author", () => {
    expect(isReviewRequest(other("grace"))).toBe(true);
    expect(isReviewRequest(other("alice"))).toBe(false);
    expect(isReviewRequest(other(" ALICE "))).toBe(false);
    expect(isReviewRequest(other(""))).toBe(false);
    expect(isReviewRequest({ ...other("grace"), feed: feedPr(11978, { author: "alice" }) })).toBe(false);
    expect(isReviewRequest({ ...other("alice"), feed: feedPr(11978, { author: "grace" }) })).toBe(true);
    // glance.waiting items are User's own unless the feed says otherwise.
    expect(isReviewRequest({ origin: "waiting", item: { title: "W", who: "QA", link: `${BE}1` } })).toBe(false);
    expect(isReviewRequest({ origin: "waiting", item: { title: "W", who: "QA", link: `${BE}1` }, feed: feedPr(1, { author: "grace" }) })).toBe(true);
    // Against the feed's login when given.
    expect(isReviewRequest(other("user"), "user")).toBe(false);
    expect(isReviewRequest(other("alice"), "")).toBe(false);
  });
});

describe("sortPrRows", () => {
  const AT = "2026-11-26T15:04:00.000Z";
  const r = (n: number, extra: { hot?: boolean; created?: string; feed?: boolean } = {}): PrRow => ({
    origin: "waiting",
    item: { title: `#${n}`, who: "QA", link: `${BE}${n}`, ...(extra.hot ? { hot: true } : {}) },
    ...(extra.feed === false ? {} : { feed: feedPr(n, { created_at: extra.created ?? "" }) }),
  });
  const order = (entries: PrRow[], hot?: Board["hot"]) => sortPrRows(entries, hot).map((x) => x.item.title);

  it("puts HOT first, then the oldest created_at first, equal times by PR number, then undated entries in their order", () => {
    const entries = [
      r(5, { created: "2026-11-20T00:00:00Z" }),
      r(9, { feed: false }),
      r(4, { created: "2026-11-10T00:00:00Z" }),
      r(7, { created: "2026-11-20T00:00:00Z" }),
      r(3, { created: "2026-11-20T00:00:00Z" }),
      r(1, { feed: false }),
      r(8, { created: "2026-11-25T00:00:00Z", hot: true }),
      r(6, { created: "not a date" }),
      r(2, { hot: true, feed: false }),
    ];
    expect(order(entries)).toEqual(["#8", "#2", "#4", "#3", "#5", "#7", "#9", "#1", "#6"]);
  });

  it("lets HOT beat age, and an explicit unhot in board.hot take the HOT priority away", () => {
    const entries = [r(1, { created: "2026-01-01T00:00:00Z" }), r(2, { created: "2026-11-01T00:00:00Z", hot: true })];
    expect(order(entries)).toEqual(["#2", "#1"]);
    expect(order(entries, { [`${BE}2`]: { hot: false, by: "cli", at: AT } })).toEqual(["#1", "#2"]);
    expect(order(entries, { [`${BE}1`]: { hot: true, by: "user", at: AT }, [`${BE}2`]: { hot: false, by: "cli", at: AT } })).toEqual(["#1", "#2"]);
  });

  it("takes the PR number from the link when the row has no feed", () => {
    const entries = [r(20, { feed: false }), r(10, { feed: false })];
    // Both undated: kept in order.
    expect(order(entries)).toEqual(["#20", "#10"]);
  });
});

describe("prSections", () => {
  const w = (title: string, extra: Partial<WaitingItem> = {}): WaitingItem => ({ title, who: "Bob's review", link: `https://github.com/acme/example-api/pull/${title}`, ...extra });
  const o = (title: string, who: string, extra: Partial<OtherPR> = {}): OtherPR => ({ title, author: "alice", who, link: `https://github.com/acme/example-api/pull/${title}`, ...extra });
  const titles = (s: Record<string, PrRow[]>) => Object.fromEntries(Object.entries(s).map(([k, rs]) => [k, rs.map((x) => x.item.title)]));

  it("has five sections, with origin labels", () => {
    expect(PR_SECTIONS.map((s) => [s.key, s.label])).toEqual([
      ["hotfix", "Hotfixes"],
      ["project", "Project PRs"],
      ["other", "Non-project PRs"],
      ["review_requests", "Review requests"],
      ["other_repos", "Other repos"],
    ]);
    expect(PR_ORIGIN_LABEL).toEqual({ waiting: "Waiting on others", others: "Others' PRs with you" });
  });

  it("files waiting and others together in file order, hot first in each section", () => {
    const glance: Board["glance"] = {
      waiting: [w("w1", { base: "project" }), w("w2"), w("w3", { base: "main", link: `${BE}3` }), w("w4", { base: "project", hot: true })],
      tickets: [],
      others: [o("o1", "Bob's fixes"), o("o2", "Your review requested", { base: "project" }), o("o3", "Your review requested"), o("o4", "Review Bot's fixes", { hot: true })],
    };
    const s = prSections(glance);
    const names = (k: keyof typeof s) => s[k].map((x) => `${x.origin}:${x.item.title}`);
    expect(names("hotfix")).toEqual(["waiting:w3"]);
    expect(names("project")).toEqual(["waiting:w4", "waiting:w1", "others:o2"]);
    expect(names("other")).toEqual(["others:o4", "waiting:w2", "others:o1", "others:o3"]);
    expect([s.review_requests, s.other_repos]).toEqual([[], []]);
  });

  it("sections a live glance snapshot (entries with no base or head) by title and link", () => {
    const glance: Board["glance"] = {
      waiting: [
        { title: "Project BE-38b: project reminder notification (#12070)", who: "Bob's review", link: `${BE}12070` },
        { title: "Site-wide single-term search (#11956)", who: "Bob's review", link: `${FE}11956` },
        { title: "Navigation project link (#11599)", who: "Review Bot's review", link: `${FE}11599`, head: "project/navigation" },
        { title: "HotFix! fix login redirect", who: "Bob's review", link: `${FE}2001`, base: "master" },
        { title: "Redact payload fields", who: "Bob's review", link: `${ADA}7`, base: "main" },
      ],
      tickets: [],
      others: [
        { title: "Project FE-22a: submit this project (frontend #11769)", author: "alice", who: "Bob's fixes", link: `${FE}11769` },
        { title: "Show job status in the dashboard (#11980)", author: "Review Bot", who: "Your review requested", link: `${BE}11980` },
        { title: "Seed tax tiers (#11800)", author: "alice", who: "Your review requested", link: `${BE}11800`, base: "project", hot: true },
        { title: "Summarize build alerts (#731)", author: "alice", who: "Bob's fixes", link: `${BE}731`, hot: true },
        { title: "Fix project rounding (#1234)", author: "alice", who: "Review Bot's fixes", link: `${BE}1234` },
        { title: "CRM change (#57)", author: "alice", who: "Bob's fixes", link: `${CRM}57`, base: "main" },
      ],
    };
    expect(titles(prSections(glance))).toEqual({
      hotfix: ["HotFix! fix login redirect"],
      // HOT first, then file order (no feed, so no created_at).
      project: ["Seed tax tiers (#11800)", "Project BE-38b: project reminder notification (#12070)", "Navigation project link (#11599)", "Project FE-22a: submit this project (frontend #11769)"],
      // The HOT #731 leads Non-project; a title that only mentions project stays here.
      other: ["Summarize build alerts (#731)", "Site-wide single-term search (#11956)", "Fix project rounding (#1234)"],
      review_requests: ["Show job status in the dashboard (#11980)"],
      other_repos: ["Redact payload fields", "CRM change (#57)"],
    });
  });

  describe("review requests", () => {
    const zach = (extra: Partial<OtherPR> = {}): OtherPR => ({ title: "Show build status in the dashboard", author: "grace", who: "Your review requested", link: `${BE}11978`, ...extra });
    const sec = (others: OtherPR[], prs: PrFeedItem[] = [], waiting: WaitingItem[] = []) => titles(prSections({ waiting, tickets: [], others }, feedByLink({ prs })));

    it("files #11978 (example-api, grace, base dev, in glance.others) under Review requests, whatever its base or repo", () => {
      const only = { hotfix: [], project: [], other: [], review_requests: ["Show build status in the dashboard"], other_repos: [] };
      expect(sec([zach()], [feedPr(11978, { author: "grace", base: "dev" })])).toEqual(only);
      expect(sec([zach()], [feedPr(11978, { author: "grace", base: "project" })])).toEqual(only);
      expect(sec([zach()], [feedPr(11978, { author: "grace", base: "main" })])).toEqual(only);
      expect(sec([zach({ link: `${CRM}60` })])).toEqual(only);
      expect(sec([zach({ link: `${CRM}60`, base: "main" })], [feedPr(60, { link: `${CRM}60`, repo: "crm", author: "grace" })])).toEqual(only);
      // Unmatched, by the glance row's own author.
      expect(sec([zach()])).toEqual(only);
    });

    it("keeps alice's PRs in his sections: crm under Other repos, example-api base main under Hotfixes", () => {
      expect(sec([], [feedPr(57, { link: `${CRM}57`, repo: "crm", base: "main" })], [{ title: "CRM", who: "QA", link: `${CRM}57` }]).other_repos).toEqual(["CRM"]);
      expect(sec([], [feedPr(2001, { base: "main" })], [{ title: "Hot", who: "QA", link: `${BE}2001` }]).hotfix).toEqual(["Hot"]);
    });

    it("keeps an unmatched glance.waiting row in his sections and sends an unmatched others row by grace to Review requests", () => {
      const s = sec([zach()], [], [{ title: "Mine", who: "QA", link: `${BE}5` }]);
      expect([s.other, s.review_requests]).toEqual([["Mine"], ["Show build status in the dashboard"]]);
    });

    it("lets the feed's author win over the glance row's own", () => {
      expect(sec([zach()], [feedPr(11978, { author: "alice" })]).other).toEqual(["Show build status in the dashboard"]);
      expect(sec([zach({ author: "alice" })], [feedPr(11978, { author: "grace" })]).review_requests).toEqual(["Show build status in the dashboard"]);
      expect(sec([], [feedPr(5, { author: "grace" })], [{ title: "W", who: "QA", link: `${BE}5` }]).review_requests).toEqual(["W"]);
    });

    it("orders Review requests HOT first, then oldest, equal times by PR number, undated last", () => {
      const row = (n: number, extra: Partial<OtherPR> = {}) => zach({ title: `#${n}`, link: `${BE}${n}`, ...extra });
      const s = sec(
        [row(40), row(30), row(20), row(10), row(50, { hot: true }), row(60, { link: `${CRM}60` })],
        [
          feedPr(30, { author: "grace", created_at: "2026-11-20T00:00:00Z" }),
          feedPr(20, { author: "grace", created_at: "2026-11-20T00:00:00Z" }),
          feedPr(10, { author: "grace", created_at: "2026-11-25T00:00:00Z" }),
          feedPr(50, { author: "grace", created_at: "2026-11-26T00:00:00Z" }),
          feedPr(60, { link: `${CRM}60`, repo: "crm", author: "grace", created_at: "2026-11-01T00:00:00Z" }),
        ],
      );
      expect(s.review_requests).toEqual(["#50", "#60", "#20", "#30", "#10", "#40"]);
    });
  });

  describe("with the GitHub feed", () => {
    const row = (title: string, n: number, extra: Partial<OtherPR> = {}): OtherPR => ({ title, author: "alice", who: "Your review requested", link: `${BE}${n}`, ...extra });
    const sections = (others: OtherPR[], prs: PrFeedItem[]) => titles(prSections({ waiting: [], tickets: [], others }, feedByLink({ prs })));
    const none = { hotfix: [], project: [], other: [], review_requests: [], other_repos: [] };

    it("keeps HOT #731 (base dev) in Non-project, first, with its HOT flag", () => {
      const s = prSections(
        { waiting: [], tickets: [], others: [row("Fix login (#11990)", 11990), row("Summarize build alerts (#731)", 731, { hot: true })] },
        feedByLink({ prs: [feedPr(731, { base: "dev", title: "Summarize build alerts", created_at: "2026-11-25T00:00:00Z" }), feedPr(11990, { base: "dev", created_at: "2026-11-01T00:00:00Z" })] }),
      );
      expect(s.other.map((x) => x.item.title)).toEqual(["Summarize build alerts (#731)", "Fix login (#11990)"]);
      expect(s.other[0].item.hot).toBe(true);
      expect(s.other[0].feed?.base).toBe("dev");
      expect([s.hotfix.length, s.project.length]).toEqual([0, 0]);
    });

    it("files by the feed's base: project base wins without the title prefix, a known dev base beats the Project title", () => {
      expect(
        sections(
          [row("Seed tax tiers (#12100)", 12100), row("Project BE-38b: reminder (#12070)", 12070), row("Project BE-40a: totals (#12071)", 12071)],
          [feedPr(12100, { base: "project" }), feedPr(12070, { base: "dev" })],
        ),
      ).toEqual({
        ...none,
        // #12071 is not in the feed, so its title still files it.
        project: ["Seed tax tiers (#12100)", "Project BE-40a: totals (#12071)"],
        other: ["Project BE-38b: reminder (#12070)"],
      });
    });

    it("counts sections from feed bases and repos, the row's own base and head winning over the feed's", () => {
      const s = sections(
        [row("A (#1)", 1), row("B (#2)", 2), row("C (#3)", 3, { base: "project" }), row("D (#4)", 4), row("E (#5)", 5), row("Project FE-1a: x (#6)", 6), row("F (#7)", 7)],
        [
          feedPr(1, { base: "main" }),
          feedPr(2, { base: "project", head: "hotfix/x" }),
          feedPr(3, { base: "dev" }),
          feedPr(4, { base: "project" }),
          feedPr(5, { base: "dev", head: "project/PROJ-1" }),
          feedPr(6, { base: "" }),
          feedPr(7, { base: "main", repo: "example-tools" }),
        ],
      );
      // #5: a known base beats the head project/ fallback; #6: a blank feed base is unknown, so the title files it.
      expect(s).toEqual({ ...none, hotfix: ["A (#1)", "B (#2)"], project: ["C (#3)", "D (#4)", "Project FE-1a: x (#6)"], other: ["E (#5)"], other_repos: ["F (#7)"] });
    });

    it("sorts Other repos like every section: HOT, then oldest first, then undated", () => {
      const crm = (title: string, n: number, extra: Partial<OtherPR> = {}) => row(title, n, { link: `${CRM}${n}`, ...extra });
      const s = sections(
        [crm("Undated (#1)", 1), crm("New (#2)", 2), crm("Old (#3)", 3), crm("Hot (#4)", 4, { hot: true })],
        [
          feedPr(2, { link: `${CRM}2`, repo: "crm", created_at: "2026-11-25T00:00:00Z" }),
          feedPr(3, { link: `${CRM}3`, repo: "crm", created_at: "2026-11-01T00:00:00Z" }),
          feedPr(4, { link: `${CRM}4`, repo: "crm", created_at: "2026-11-26T00:00:00Z" }),
        ],
      );
      expect(s.other_repos).toEqual(["Hot (#4)", "Old (#3)", "New (#2)", "Undated (#1)"]);
    });

    it("joins by link despite a trailing slash or #fragment, leaves unmatched entries alone, and adds no feed-only PRs", () => {
      const s = prSections(
        { waiting: [{ title: "W (#7)", who: "QA", link: `${BE}7/` }], tickets: [], others: [row("O (#8)", 8, { link: `${BE}8#discussion_r9` }), row("Plain (#9)", 9)] },
        feedByLink({ prs: [feedPr(7, { base: "project" }), feedPr(8), feedPr(99, { base: "project" })] }),
      );
      const all = PR_SECTIONS.flatMap((x) => s[x.key]);
      expect(all.map((x) => [x.item.title, x.feed?.number ?? null])).toEqual([
        ["W (#7)", 7],
        ["O (#8)", 8],
        ["Plain (#9)", null],
      ]);
      expect(all.find((x) => x.item.title === "Plain (#9)")).toEqual({ origin: "others", item: row("Plain (#9)", 9) });
    });

    it("uses a project title fallback when neither the list nor the feed has a base", () => {
      expect(sections([row("Project FE-11: Preview (#11)", 11)], [feedPr(11, { base: "" })]))
        .toEqual({ ...none, project: ["Project FE-11: Preview (#11)"] });
    });
  });

  it("names the repo of a row outside example-api and example-web, from the feed or the link", () => {
    const item = (link: string): PrRow => ({ origin: "waiting", item: { title: "T", who: "QA", link } });
    expect(otherRepoOf(item(`${CRM}57`))).toBe("acme/crm");
    expect(otherRepoOf(item(`${ADA}7`))).toBe("acme/example-tools");
    expect(otherRepoOf(item(`${BE}1`))).toBe("");
    expect(otherRepoOf(item("https://example.com/pr/1"))).toBe("");
    expect(otherRepoOf({ ...item(`${BE}1`), feed: feedPr(1, { repo: "crm" }) })).toBe("crm");
  });

  it("works on a glance without others (older files)", () => {
    expect(prSections({ waiting: [w("a")], tickets: [] })).toEqual({ hotfix: [], project: [], other: [{ origin: "waiting", item: w("a") }], review_requests: [], other_repos: [] });
  });
});
