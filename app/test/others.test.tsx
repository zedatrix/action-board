// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBoard, parseBoardSource } from "../src/data/parse";
import type { Board, OtherPR } from "../src/data/types";
import { sortOthers } from "../src/others";

const pr = (title: string, who: string, author = "Blake"): OtherPR => ({ title, author, who, link: `https://github.com/o/r/pull/${title.length}${title.charCodeAt(0)}` });

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
  render(<App />);
}

const panelHeadings = () => [...document.querySelectorAll(".glance .panel h3")].map((h) => h.textContent?.replace(/\s+/g, " ").trim());
const othersPanel = () => screen.getByRole("heading", { name: /^Others' PRs with you/ }).closest("section")!;

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

describe("Others' PRs with you panel", () => {
  const others = [pr("Billing banner", "Blake's fixes", "Riley"), pr("Tax tiers", "Your review requested", "Blake"), pr("chat alerts", "review requested", "Kai")];
  const glance: Board["glance"] = {
    waiting: [{ title: "My PR", who: "Vlad", link: "https://github.com/o/r/pull/9" }],
    tickets: [{ id: "PROJ-1", title: "A ticket", status: "To Do" }],
    others,
  };

  it("sits between Waiting on others and Tickets, with its count", async () => {
    await renderApp(base(glance));
    expect(panelHeadings()).toEqual(["Waiting on others 1", "Others' PRs with you 3", "Tickets with no PR yet 1"]);
  });

  it("lists review requests first, each row a new-tab link with title, author and who", async () => {
    await renderApp(base(glance));
    const lines = [...othersPanel().querySelectorAll("li.row")];
    expect(lines.map((r) => r.querySelector(".title")?.textContent)).toEqual(["Tax tiers", "chat alerts", "Billing banner"]);
    expect(lines.map((r) => r.querySelector(".meta")?.textContent)).toEqual(["Blake · Your review requested", "Kai · review requested", "Riley · Blake's fixes"]);
    for (const [i, r] of lines.entries()) {
      const a = r.querySelector("a.item")!;
      expect(a.getAttribute("href")).toBe([others[1], others[2], others[0]][i].link);
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("gives each row a Message your assistant button and data-item-section others", async () => {
    await renderApp(base(glance));
    const lines = [...othersPanel().querySelectorAll("li.row")] as HTMLElement[];
    expect(lines).toHaveLength(3);
    for (const r of lines) {
      expect(r.getAttribute("data-item-section")).toBe("others");
      expect(r.getAttribute("data-item-id")).toBe(r.querySelector("a.item")!.getAttribute("href"));
      const title = r.querySelector(".title")!.textContent!;
      expect(within(r).getByRole("button", { name: `Message your assistant about ${title}` })).toBeTruthy();
    }
  });

  it("shows count 0 and Nothing here. when the file has no others", async () => {
    const { others: _, ...old } = glance;
    await renderApp(base(old));
    expect(panelHeadings()).toEqual(["Waiting on others 1", "Others' PRs with you 0", "Tickets with no PR yet 1"]);
    expect(within(othersPanel()).getByText("Nothing here.")).toBeTruthy();
    expect(othersPanel().querySelectorAll("li")).toHaveLength(0);
  });
});
