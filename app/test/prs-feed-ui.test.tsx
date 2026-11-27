// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";
import type { PrFeed } from "../src/feedTypes";
import { prsPanel, sectionHeadings, withPrs } from "./board-with-prs";
import { feedOf, feedPr } from "./feed-pr";
import fixture from "./fixtures/sample-pr.json";
import { normalizePr } from "../server/feed";

const link = (n: number) => `https://github.com/acme/example-api/pull/${n}`;

const state = vi.hoisted(() => ({ board: undefined as unknown }));
vi.mock("../src/data/board", () => ({
  get board() {
    return state.board;
  },
}));

// A stand-in for the browser's EventSource that the test drives by hand.
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  constructor(public url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = 2;
  }
  feed(f: PrFeed) {
    this.readyState = 1;
    this.dispatchEvent(new MessageEvent("feed", { data: JSON.stringify(f) }));
  }
}

const glance: Board["glance"] = {
  waiting: [
    { title: "Seed tax tiers (#12100)", who: "QA", link: link(12100) },
    { title: "Project BE-38b: reminder (#12070)", who: "Bob's review", link: `${link(12070)}/` },
  ],
  others: [
    { title: "Summarize build alerts (#731)", author: "alice", who: "Review Bot's check", link: link(731), hot: true },
    { title: "Project FE-22a: submit (#11769)", author: "alice", who: "Your review requested", link: link(11769) },
    // Zach's PR: a review request, even into project.
    { title: "Show build status in the dashboard (#11978)", author: "grace", who: "Your review requested", link: link(11978) },
  ],
  tickets: [{ id: "PROJ-1", title: "Ticket A", status: "In Review", link: "https://linear.app/acme/issue/PROJ-1" }],
};

const Bob = { login: "bob", state: "CHANGES_REQUESTED", at: "", commit: "33333333", on_head: false, requested: true } as const;

const rich = feedPr(731, {
  base: "dev",
  ci: "failing",
  failing_checks: 2,
  review_decision: "CHANGES_REQUESTED",
  reviewers: [Bob],
  labels: [
    { name: "backend", color: "1d76db" },
    { name: "needs QA", color: "not-a-color" },
  ],
  comments: 5,
  additions: 120,
  deletions: 7,
  unresolved_count: 3,
  unresolved: [
    { author: "Review Bot", path: "app/Alerts.php", body: "<img src=x onerror=alert(1)>\nsecond line", url: "https://github.com/acme/example-api/pull/731#discussion_r1" },
    { author: "Dana", path: "", body: "Looks off", url: "https://evil.example/phish" },
  ],
});
const feed = feedOf([
  rich,
  feedPr(12100, {
    base: "project",
    ci: "passing",
    comments: 1,
    failing_checks: 1,
    review_decision: "CHANGES_REQUESTED",
    reviewers: [{ ...Bob, on_head: true, requested: false }],
    unresolved_count: 1,
    unresolved_more: true,
    unresolved: [{ author: "Dana", path: "db/tiers.sql", body: "Seed order matters", url: "" }],
  }),
  feedPr(12070, { base: "dev", ci: "pending" }),
  feedPr(11978, { author: "grace", mine: false, base: "project", ci: "passing", comments: 2 }),
  // In the feed but not on the board: never shown.
  feedPr(4242, { title: "Feed only PR", base: "project" }),
]);

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", "");
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in tests"))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function renderPrs(f?: PrFeed) {
  state.board = { updated_at: "2026-11-10T09:00:00.000Z", decisions: [], glance };
  const { default: App } = await import("../src/App");
  const BoardAndPrs = withPrs(App);
  render(<BoardAndPrs />);
  if (f) push(f);
}
const push = (f: PrFeed) => act(() => FakeEventSource.instances[0].feed(f));

const row = (title: string) => [...prsPanel().querySelectorAll<HTMLElement>("li.row")].find((r) => r.querySelector(".title")?.textContent === title)!;
const chips = (r: HTMLElement) => [...r.querySelectorAll(".pr-chips .chip")].map((c) => c.textContent);
const titles = (name: RegExp) => [...within(prsPanel()).getByRole("heading", { name }).closest("section")!.querySelectorAll("li.row .title")].map((t) => t.textContent);

describe("PRs tab with the GitHub feed", () => {
  it("before any feed: entries are as before (no chips, no chevron) and sections come from titles", async () => {
    await renderPrs();
    expect(sectionHeadings()).toEqual(["Hotfixes 0", "Non-project PRs 2", "Project PRs 2", "Tickets with no PR yet 1", "Review requests 1", "Other repos 0"]);
    expect(prsPanel().querySelectorAll(".pr-chips, .chev-btn, .pr-detail")).toHaveLength(0);
    expect(prsPanel().querySelector(".pr-feed-status")?.textContent).toBe("PR details from GitHub: not loaded yet");
  });

  it("sections by the feed's base, keeps #731 HOT and first in Non-project, and adds no feed-only PRs", async () => {
    await renderPrs(feed);
    expect(sectionHeadings()).toEqual(["Hotfixes 0", "Non-project PRs 2", "Project PRs 2", "Tickets with no PR yet 1", "Review requests 1", "Other repos 0"]);
    expect(titles(/^Project PRs/)).toEqual(["Seed tax tiers (#12100)", "Project FE-22a: submit (#11769)"]);
    expect(titles(/^Non-project PRs/)).toEqual(["Summarize build alerts (#731)", "Project BE-38b: reminder (#12070)"]);
    const hot = row("Summarize build alerts (#731)");
    expect(hot.querySelector(".hot-badge")?.textContent).toBe("HOT");
    expect(hot.classList.contains("hot")).toBe(true);
    expect(prsPanel().textContent).not.toContain("Feed only PR");
  });

  it("gives Review requests entries the chevron, chips, flame and origin label like every row", async () => {
    await renderPrs(feed);
    expect(titles(/^Review requests/)).toEqual(["Show build status in the dashboard (#11978)"]);
    const r = row("Show build status in the dashboard (#11978)");
    expect([...r.querySelector(".row-lead")!.children].map((c) => c.className)).toEqual(["chev-btn", "hot-flame"]);
    expect(chips(r)).toEqual(["CI passing", "2 comments"]);
    expect(r.querySelector(".origin")?.textContent).toBe("Others' PRs with you");
    expect(r.querySelector(".repo-chip")).toBeNull();
    // The feed's login decides whose PRs are "mine": signed in as someone else, every alice row is a review request.
    push({ ...feed, github: { ...feed.github, login: "someone-else" } });
    expect(titles(/^Review requests/)).toHaveLength(5);
  });

  it("shows reason, CI, label, comment and line chips under the title", async () => {
    await renderPrs(feed);
    const r = row("Summarize build alerts (#731)");
    expect(chips(r)).toEqual(["changes requested by bob · re-review requested", "2 failing checks", "3 open threads", "CI failing", "backend", "needs QA", "5 comments", "+120 −7"]);
    expect([...r.querySelectorAll(".reason-chip")].map((c) => c.textContent)).toEqual(["changes requested by bob · re-review requested", "2 failing checks", "3 open threads"]);
    expect(r.querySelector(".ci-chip")!.className).toBe("chip ci-chip ci-failing");
    const [tinted, plain] = [...r.querySelectorAll<HTMLElement>(".label-chip")];
    expect(tinted.style.backgroundColor).toBe("rgba(29, 118, 219, 0.18)");
    expect(plain.getAttribute("style")).toBeNull();
    expect(r.querySelector(".lines-chip .add")?.textContent).toBe("+120");
    expect(r.querySelector(".lines-chip .del")?.textContent).toBe("−7");
    // Chips sit under the title, inside the row's link, above the origin label; the meta and Message Assistant stay.
    const main = r.querySelector("a.item .pr-main")!;
    expect([...main.children].map((c) => c.className)).toEqual(["pr-line", "pr-chips", "origin"]);
    expect(r.querySelector(".meta")?.textContent).toBe("alice · Review Bot's check");
    expect(within(r).getByRole("button", { name: "Message your assistant about Summarize build alerts (#731)" })).toBeTruthy();

    // Singular forms, CI passing; zero comments and zero lines show no chip; CI none shows no chip.
    expect(chips(row("Seed tax tiers (#12100)"))).toEqual(["changes requested by bob", "1 failing check", "1+ open threads", "CI passing", "1 comment"]);
    expect(row("Seed tax tiers (#12100)").querySelector(".reason-chip")?.textContent).toBe("changes requested by bob");
    expect(chips(row("Project BE-38b: reminder (#12070)"))).toEqual(["CI pending"]);
    push(feedOf([feedPr(12070)]));
    expect(chips(row("Project BE-38b: reminder (#12070)"))).toEqual([]);
  });

  it("lets chip text wrap without clipping", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    const chipRule = styles.match(/^\.chip\s*\{([^}]*)\}/m)?.[1];
    expect(chipRule).toMatch(/white-space:\s*normal\s*;/);
    expect(chipRule).not.toMatch(/\boverflow:\s*hidden\b|\btext-overflow:\s*ellipsis\b/);
  });

  it("shows #731's three reviewers and carol’s thread from the sample response", async () => {
    const first = fixture.threadNodes[0].comments.nodes[0];
    const pr = normalizePr(fixture.pullRequest, fixture.viewer.login, new Map([[fixture.threadNodes[0].id, first]]));
    await renderPrs(feedOf([pr]));
    const r = row("Summarize build alerts (#731)");
    expect(chips(r)).toEqual(["changes requested by bob · re-review requested", "1 open thread", "87 comments"]);
    fireEvent.click(within(r).getByRole("button", { name: "Show details" }));
    const detail = r.querySelector<HTMLElement>(".pr-detail")!;
    expect(within(detail).getAllByRole("heading").map((h) => h.textContent)).toEqual(["Reviewers", "Open threads 1"]);
    expect([...detail.querySelectorAll(".pr-reviewers li")].map((li) => li.textContent)).toEqual([
      "bob: changes requested (on older head 33333333, re-review requested)",
      "carol: commented",
      "dana: approved",
    ]);
    expect(detail.querySelector(".pr-thread-head")?.textContent).toContain(`carol on ${first.path}`);
    expect(detail.querySelector(".pr-text")?.textContent).toBe(first.body);
    expect(prsPanel().textContent).not.toContain("awaiting re-review");
    expect(r.querySelector(".meta")?.textContent).toBe("alice · Review Bot's check");
  });

  it("leaves unmatched entries as before, with only the HOT flame in the lead", async () => {
    await renderPrs(feed);
    const r = row("Project FE-22a: submit (#11769)");
    expect(r.className).toBe("row has-lead");
    expect(r.querySelector(".chev-btn, .pr-chips")).toBeNull();
    expect([...r.querySelector(".row-lead")!.children].map((c) => c.className)).toEqual(["hot-flame"]);
    expect([...r.querySelector(".pr-main")!.children].map((c) => c.className)).toEqual(["pr-line", "origin"]);
  });

  it("opens details with the chevron, without following the row link, and keeps them open through live updates", async () => {
    await renderPrs(feed);
    const chev = () => within(row("Summarize build alerts (#731)")).getByRole("button", { name: "Show details" });
    expect(chev().getAttribute("aria-expanded")).toBe("false");
    expect(chev().closest("a")).toBeNull();
    expect(chev().tagName).toBe("BUTTON");
    expect(row("Summarize build alerts (#731)").querySelector(".pr-detail")).toBeNull();

    fireEvent.click(chev());
    expect(chev().getAttribute("aria-expanded")).toBe("true");
    const detail = row("Summarize build alerts (#731)").querySelector<HTMLElement>(".pr-detail")!;
    expect(chev().getAttribute("aria-controls")).toBe(detail.id);
    expect(detail.closest("a")).toBeNull();

    // A live update that changes the PR keeps it open, with the new data.
    push(feedOf([{ ...rich, unresolved: [{ ...rich.unresolved[0], body: "Rewritten" }] }]));
    expect(chev().getAttribute("aria-expanded")).toBe("true");
    expect(row("Summarize build alerts (#731)").querySelector(".pr-detail .pr-text")?.textContent).toBe("Rewritten");

    fireEvent.click(chev());
    expect(row("Summarize build alerts (#731)").querySelector(".pr-detail")).toBeNull();
  });

  it("renders the human unresolved comments as plain text, with no description, linking only to https://github.com", async () => {
    await renderPrs(feed);
    fireEvent.click(within(row("Summarize build alerts (#731)")).getByRole("button", { name: "Show details" }));
    const detail = row("Summarize build alerts (#731)").querySelector<HTMLElement>(".pr-detail")!;
    expect(detail.querySelector("img, script")).toBeNull();
    expect(detail.textContent).not.toMatch(/Description/);
    const texts = [...detail.querySelectorAll(".pr-text")].map((p) => p.textContent);
    expect(texts).toEqual(["<img src=x onerror=alert(1)>\nsecond line", "Looks off"]);
    expect(within(detail).getByRole("heading", { name: "Open threads 3" })).toBeTruthy();
    const heads = [...detail.querySelectorAll(".pr-thread-head")];
    expect(heads.map((h) => h.textContent)).toEqual(["Review Bot on app/Alerts.php · View on GitHub", "Dana on the PR"]);
    const links = [...detail.querySelectorAll("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")])).toEqual([
      ["View on GitHub", "https://github.com/acme/example-api/pull/731#discussion_r1", "_blank", "noopener noreferrer"],
    ]);
    expect(detail.textContent).toContain("1 more on GitHub.");
  });

  it("says No human reviews or open threads. when the PR has none, and N+ when there may be more", async () => {
    await renderPrs(feed);
    fireEvent.click(within(row("Project BE-38b: reminder (#12070)")).getByRole("button", { name: "Show details" }));
    const detail = row("Project BE-38b: reminder (#12070)").querySelector(".pr-detail")!;
    expect(detail.textContent).toBe("No human reviews or open threads.");
    expect(detail.querySelector(".pr-threads")).toBeNull();
    fireEvent.click(within(row("Seed tax tiers (#12100)")).getByRole("button", { name: "Show details" }));
    expect(within(row("Seed tax tiers (#12100)")).getByRole("heading", { name: "Open threads 1+" })).toBeTruthy();
  });

  it("shows when the feed last ran in Eastern time, and a GitHub error without hiding the entries", async () => {
    await renderPrs(feed);
    const status = () => prsPanel().querySelector(".pr-feed-status")!;
    expect(status().textContent).toBe("Last updated 10:04 AM ET");
    expect(status().querySelector("time")?.getAttribute("dateTime")).toBe("2026-11-26T15:04:00Z");
    expect(within(prsPanel()).queryByRole("status")).toBeNull();

    push({ ...feed, github: { ok: false, login: "alice", error: "gh: HTTP 502", last_ok: feed.fetched_at } });
    expect(within(prsPanel()).getByRole("status").textContent).toBe("GitHub feed error: gh: HTTP 502, showing last good data");
    expect(chips(row("Summarize build alerts (#731)"))).toContain("CI failing");
  });
});

describe("asking the server for a fresh feed", () => {
  const refreshes = () => vi.mocked(fetch).mock.calls.filter(([url]) => url === "/__ab/feed/refresh");

  async function renderTabs(hash: string) {
    window.history.replaceState(null, "", `/${hash}`);
    state.board = { updated_at: "2026-11-10T09:00:00.000Z", decisions: [], glance };
    const { default: Tabs } = await import("../src/Tabs");
    render(<Tabs />);
  }

  it("posts /__ab/feed/refresh when the PRs tab is selected, never while it is hidden, and ignores the failure", async () => {
    await renderTabs("");
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(refreshes()).toHaveLength(0);
    fireEvent.click(screen.getByRole("tab", { name: "PRs" }));
    await waitFor(() => expect(refreshes()).toHaveLength(1));
    expect(refreshes()[0][1]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    // The fetch mock rejects; the tab keeps working. A focus within 30 seconds is debounced.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(refreshes()).toHaveLength(1);
    expect(sectionHeadings()).toHaveLength(6);
  });

  it("posts once on a load at #prs", async () => {
    await renderTabs("#prs");
    await waitFor(() => expect(refreshes()).toHaveLength(1));
  });
});
