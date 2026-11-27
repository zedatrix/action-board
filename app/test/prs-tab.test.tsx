// @vitest-environment jsdom
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";
import { prsPanel, sectionHeadings, withPrs } from "./board-with-prs";

const link = (n: number) => `https://github.com/acme/example-api/pull/${n}`;

// The bundled board for the next import of App or Tabs; never the real board.ts.
const state = vi.hoisted(() => ({ board: undefined as unknown }));
vi.mock("../src/data/board", () => ({
  get board() {
    return state.board;
  },
}));

const glance: Board["glance"] = {
  waiting: [
    { title: "Fix login (#1)", who: "Dana", link: link(1), base: " Main " },
    { title: "Project export (#2)", who: "QA", link: link(2), base: "project" },
    { title: "Docs (#3)", who: "Bob", link: link(3), base: "develop", hot: true },
    { title: "HotFix! tax rounding (#4)", who: "QA", link: link(4), base: "develop" },
    // User's crm PR into main: Other repos, not Hotfixes.
    { title: "CRM change (#57)", who: "QA", link: "https://github.com/acme/crm/pull/57", base: "main" },
  ],
  others: [
    // On User's account (fleet-built): filed by branches like his own.
    { title: "Banner (#5)", author: "alice", who: "Bob's fixes", link: link(5), head: "hotfix/banner", hot: true },
    { title: "Tiers (#6)", author: "alice", who: "Waiting on CI", link: link(6), base: "project" },
    // Someone else's: Review requests, whatever the branches.
    { title: "Build alerts (#7)", author: "Eli", who: "Two approvals", link: link(7) },
    { title: "Reports (#8)", author: "alice", who: "Your review requested", link: link(8), base: "develop" },
    { title: "Show build status in the dashboard (#11978)", author: "grace", who: "Your review requested", link: link(11978), base: "main" },
  ],
  tickets: [{ id: "PROJ-1", title: "Ticket A", status: "In Review", link: "https://linear.app/acme/issue/PROJ-1" }],
};
const board = (g: Board["glance"]): Board => ({ updated_at: "2026-11-10T09:00:00.000Z", decisions: [], glance: g });

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.resetModules();
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", "");
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in tests"))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function renderPrs(b: Board) {
  state.board = b;
  const { default: App } = await import("../src/App");
  const BoardAndPrs = withPrs(App);
  render(<BoardAndPrs />);
}

const section = (name: RegExp) => within(prsPanel()).getByRole("heading", { name }).closest("section")!;
const entries = (name: RegExp) => [...section(name).querySelectorAll<HTMLElement>("li.row")];
const titles = (name: RegExp) => entries(name).map((r) => r.querySelector(".title")?.textContent);
const origins = (name: RegExp) => entries(name).map((r) => r.querySelector(".origin")?.textContent);

describe("PRs tab", () => {
  it("renders Hotfixes, Non-project PRs, Project PRs, Tickets with no PR yet, Review requests, then Other repos, in that DOM order, with counts", async () => {
    await renderPrs(board(glance));
    // The two-column grid fills row by row: Hotfixes | Non-project on top, Project | Tickets below, then Review
    // requests and Other repos each across the full width.
    const grid = prsPanel().querySelector(".prs-grid")!;
    const panels = [...grid.children] as HTMLElement[];
    expect(panels.map((s) => s.dataset.section)).toEqual(["hotfix", "other", "project", "tickets", "review_requests", "other_repos"]);
    expect(panels.map((s) => s.classList.contains("panel-wide"))).toEqual([false, false, false, false, true, true]);
    expect(sectionHeadings()).toEqual(["Hotfixes 2", "Non-project PRs 3", "Project PRs 2", "Tickets with no PR yet 1", "Review requests 2", "Other repos 1"]);
    // The PRs total counts every PR section (tickets are not PRs).
    expect(within(prsPanel()).getByRole("heading", { level: 2 }).textContent?.replace(/\s+/g, " ")).toBe("PRs 10");
  });

  it("files each PR by author, repo and branches, from both lists, with its origin label; a HotFix! title alone is not a hotfix", async () => {
    await renderPrs(board(glance));
    expect(titles(/^Hotfixes/)).toEqual(["Banner (#5)", "Fix login (#1)"]);
    expect(origins(/^Hotfixes/)).toEqual(["Others' PRs with you", "Waiting on others"]);
    expect(titles(/^Project PRs/)).toEqual(["Project export (#2)", "Tiers (#6)"]);
    expect(origins(/^Project PRs/)).toEqual(["Waiting on others", "Others' PRs with you"]);
    // Hot first, then (no feed dates) waiting in file order, then others in file order.
    expect(titles(/^Non-project PRs/)).toEqual(["Docs (#3)", "HotFix! tax rounding (#4)", "Reports (#8)"]);
    expect(origins(/^Non-project PRs/)).toEqual(["Waiting on others", "Waiting on others", "Others' PRs with you"]);
    // #11978 is Zach's: a review request even with base main.
    expect(titles(/^Review requests/)).toEqual(["Build alerts (#7)", "Show build status in the dashboard (#11978)"]);
    expect(origins(/^Review requests/)).toEqual(["Others' PRs with you", "Others' PRs with you"]);
    expect(titles(/^Other repos/)).toEqual(["CRM change (#57)"]);
  });

  it("labels Other repos entries with their repo, and no other row", async () => {
    await renderPrs(board(glance));
    const [crm] = entries(/^Other repos/);
    expect(crm.querySelector(".pr-line .repo-chip")?.textContent).toBe("acme/crm");
    expect(crm.querySelector(".pr-line .title + .repo-chip")).toBeTruthy();
    expect(prsPanel().querySelectorAll(".repo-chip")).toHaveLength(1);
    // It still gets the flame like every PR row.
    expect(within(crm).getByRole("button", { name: /^(Mark|Remove) HOT$/ })).toBeTruthy();
  });

  it("keeps each row's look: a new-tab link with who (waiting) or author · who (others), and data-item-section by origin", async () => {
    await renderPrs(board(glance));
    const [banner, login] = entries(/^Hotfixes/);
    expect(banner.querySelector(".meta")?.textContent).toBe("alice · Bob's fixes");
    expect(login.querySelector(".meta")?.textContent).toBe("Dana");
    expect([banner.dataset.itemSection, login.dataset.itemSection]).toEqual(["others", "waiting"]);
    for (const r of [banner, login]) {
      const a = r.querySelector("a.item")!;
      expect(a.getAttribute("href")).toBe(r.dataset.itemId);
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(within(r).getByRole("button", { name: `Message your assistant about ${r.querySelector(".title")!.textContent}` })).toBeTruthy();
    }
  });

  it("shows a visible HOT badge on hot PRs only, and sorts them first in their section", async () => {
    await renderPrs(board(glance));
    const badges = [...prsPanel().querySelectorAll(".hot-badge")];
    expect(badges.map((b) => b.textContent)).toEqual(["HOT", "HOT"]);
    expect(badges.map((b) => b.closest("li")!.querySelector(".title")!.textContent)).toEqual(["Banner (#5)", "Docs (#3)"]);
    expect(within(entries(/^Hotfixes/)[0]).getByText("HOT")).toBeTruthy();
    expect(entries(/^Hotfixes/)[0].classList.contains("hot")).toBe(true);
    expect(entries(/^Hotfixes/)[1].querySelector(".hot-badge")).toBeNull();
    expect(entries(/^Project PRs/).some((r) => r.querySelector(".hot-badge"))).toBe(false);
  });

  it("keeps the tickets panel as it was: id, title, status, link", async () => {
    await renderPrs(board(glance));
    const [t] = entries(/^Tickets with no PR yet/);
    expect(t.dataset.itemSection).toBe("tickets");
    expect(t.dataset.itemId).toBe("PROJ-1");
    expect(t.querySelector(".tid")?.textContent).toBe("PROJ-1");
    expect(t.querySelector(".title")?.textContent).toBe("PROJ-1Ticket A");
    expect(t.querySelector(".status")?.className).toBe("status review");
    expect(t.querySelector("a.item")?.getAttribute("href")).toBe("https://linear.app/acme/issue/PROJ-1");
  });

  it("shows Nothing here. in every empty section, and loads a board without others", async () => {
    await renderPrs(board({ waiting: [], tickets: [] }));
    expect(sectionHeadings()).toEqual(["Hotfixes 0", "Non-project PRs 0", "Project PRs 0", "Tickets with no PR yet 0", "Review requests 0", "Other repos 0"]);
    expect(within(prsPanel()).getAllByText("Nothing here.")).toHaveLength(6);
    expect(prsPanel().querySelectorAll("li")).toHaveLength(0);
  });

  it("leaves nothing PR or ticket related on the Board tab", async () => {
    state.board = board(glance);
    const { default: Tabs } = await import("../src/Tabs");
    render(<Tabs />);
    const boardPanel = document.getElementById("panel-board")!;
    expect(boardPanel.querySelectorAll("[data-item-id], a.item, .hot-badge, .panel")).toHaveLength(0);
    for (const text of ["Hotfixes", "Project PRs", "Review requests", "Other repos", "Waiting on others", "Others' PRs with you", "Tickets with no PR yet", "Fix login", "Ticket A"]) {
      expect(boardPanel.textContent).not.toContain(text);
    }
    // They are all on the PRs tab instead.
    const prs = document.getElementById("panel-prs")!;
    expect(prs.querySelectorAll("li.row")).toHaveLength(11);
    expect(prs.textContent).toContain("Ticket A");
  });
});
