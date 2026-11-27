// @vitest-environment jsdom
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBoard, parseBoardSource } from "../src/data/parse";
import type { Board, OtherPR } from "../src/data/types";
import { sortOthers } from "../src/others";
import { prsPanel, sectionHeadings, withPrs } from "./board-with-prs";

const pr = (title: string, who: string, author = "Blake"): OtherPR => ({ title, author, who, link: `https://github.com/acme/example-api/pull/${title.length}${title.charCodeAt(0)}` });

// The bundled board for the next import of App; never the real board.ts.
const state = vi.hoisted(() => ({ board: undefined as unknown }));
vi.mock("../src/data/board", () => ({
  get board() {
    return state.board;
  },
}));

const base = (glance: Board["glance"]): Board => ({ updated_at: "2026-11-10T09:00:00.000Z", decisions: [], glance });

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", "");
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in tests"))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function renderApp(board: unknown) {
  state.board = board;
  const { default: App } = await import("../src/App");
  const BoardAndPrs = withPrs(App);
  render(<BoardAndPrs />);
}

const nonProject = () => within(prsPanel()).getByRole("heading", { name: /^Non-project PRs/ }).closest("section")!;
const othersRows = () => [...nonProject().querySelectorAll<HTMLElement>('li.row[data-item-section="others"]')];

describe("sortOthers", () => {
  it("puts review requested first, case-insensitive, and keeps the order within each group", () => {
    const a = pr("A", "Blake's fixes");
    const b = pr("B", "Your review requested");
    const c = pr("C", "CI failing");
    const d = pr("D", "REVIEW REQUESTED from you");
    const e = pr("E", "Re-review requested");
    expect(sortOthers([a, b, c, d, e])).toEqual([b, d, e, a, c]);
  });

  it("leaves a list with no review requests as it is, and does not change its input", () => {
    const list = [pr("A", "Blake's fixes"), pr("B", "Waiting on QA")];
    const copy = [...list];
    expect(sortOthers(list)).toEqual(copy);
    expect(sortOthers([])).toEqual([]);
    sortOthers([list[1], pr("C", "review requested")]);
    expect(list).toEqual(copy);
  });
});

describe("isBoard and others", () => {
  it("accepts a board without others and with an others array", () => {
    expect(isBoard(base({ waiting: [], tickets: [] }))).toBe(true);
    expect(isBoard(base({ waiting: [], tickets: [], others: [pr("A", "x")] }))).toBe(true);
  });

  it("rejects others that is not an array", () => {
    for (const others of [{}, "x", 3, null]) expect(isBoard({ ...base({ waiting: [], tickets: [] }), glance: { waiting: [], tickets: [], others } })).toBe(false);
  });

  it("parses a board.ts source without others", () => {
    const src = `/* BOARD-JSON-START */\n${JSON.stringify(base({ waiting: [], tickets: [] }))}\n/* BOARD-JSON-END */`;
    expect(parseBoardSource(src).glance.others).toBeUndefined();
  });
});

// Others' PRs used to have their own Board panel; they now sit on the PRs tab. One someone else authored goes under
// Review requests; one on the viewer’s account (alice) goes to the section its branches pick (no base or head:
// Non-project PRs). Each is labeled with where it came from.
describe("Others' PRs with you on the PRs tab", () => {
  const others = [pr("Billing banner", "Bob's fixes", "Review Bot"), pr("Tax tiers", "Your review requested", "Bob"), pr("Build alerts", "review requested", "Eli"), pr("Fleet fix", "Bob's fixes", "alice")];
  const glance: Board["glance"] = {
    waiting: [{ title: "My PR", who: "Dana", link: "https://github.com/acme/example-api/pull/9" }],
    tickets: [{ id: "PROJ-1", title: "A ticket", status: "To Do" }],
    others,
  };
  const reviewRequests = () => within(prsPanel()).getByRole("heading", { name: /^Review requests/ }).closest("section")!;
  const requestRows = () => [...reviewRequests().querySelectorAll<HTMLElement>("li.row")];

  it("files others' PRs under Review requests and the viewer’s with the waiting PRs, with counts, and none on the Board", async () => {
    await renderApp(base(glance));
    expect(sectionHeadings()).toEqual(["Hotfixes 0", "Non-project PRs 2", "Project PRs 0", "Tickets with no PR yet 1", "Review requests 3", "Other repos 0"]);
    expect(othersRows().map((r) => r.querySelector(".title")?.textContent)).toEqual(["Fleet fix"]);
    expect(document.querySelector(".page")!.querySelectorAll("[data-item-section]")).toHaveLength(0);
  });

  it("lists review requests in file order (no feed dates), each row a new-tab link with title, author and who, labeled Others' PRs with you", async () => {
    await renderApp(base(glance));
    const entries = requestRows();
    expect(entries.map((r) => r.querySelector(".origin")?.textContent)).toEqual(["Others' PRs with you", "Others' PRs with you", "Others' PRs with you"]);
    expect(entries.map((r) => r.querySelector(".title")?.textContent)).toEqual(["Billing banner", "Tax tiers", "Build alerts"]);
    expect(entries.map((r) => r.querySelector(".meta")?.textContent)).toEqual(["Review Bot · Bob's fixes", "Bob · Your review requested", "Eli · review requested"]);
    for (const [i, r] of entries.entries()) {
      const a = r.querySelector("a.item")!;
      expect(a.getAttribute("href")).toBe(others[i].link);
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("gives each row a Message your assistant button and data-item-section others", async () => {
    await renderApp(base(glance));
    const entries = [...prsPanel().querySelectorAll<HTMLElement>('li.row[data-item-section="others"]')];
    expect(entries).toHaveLength(4);
    for (const r of entries) {
      expect(r.getAttribute("data-item-section")).toBe("others");
      expect(r.getAttribute("data-item-id")).toBe(r.querySelector("a.item")!.getAttribute("href"));
      const title = r.querySelector(".title")!.textContent!;
      expect(within(r).getByRole("button", { name: `Message your assistant about ${title}` })).toBeTruthy();
    }
  });

  it("counts none and lists none when the file has no others", async () => {
    const { others: _, ...old } = glance;
    await renderApp(base(old));
    expect(sectionHeadings()).toEqual(["Hotfixes 0", "Non-project PRs 1", "Project PRs 0", "Tickets with no PR yet 1", "Review requests 0", "Other repos 0"]);
    expect(othersRows()).toHaveLength(0);
    expect(nonProject().querySelector(".origin")?.textContent).toBe("Waiting on others");
  });

  it("shows count 0 and Nothing here. in every PR section when there are no PRs", async () => {
    await renderApp(base({ waiting: [], tickets: glance.tickets }));
    expect(sectionHeadings()).toEqual(["Hotfixes 0", "Non-project PRs 0", "Project PRs 0", "Tickets with no PR yet 1", "Review requests 0", "Other repos 0"]);
    for (const name of [/^Hotfixes/, /^Project PRs/, /^Non-project PRs/, /^Review requests/, /^Other repos/]) {
      const section = within(prsPanel()).getByRole("heading", { name }).closest("section")!;
      expect(within(section).getByText("Nothing here.")).toBeTruthy();
      expect(section.querySelectorAll("li")).toHaveLength(0);
    }
  });
});
