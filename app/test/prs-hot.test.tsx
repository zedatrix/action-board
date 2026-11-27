// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";
import { isHot, prSections } from "../src/prs";
import { prsPanel, withPrs } from "./board-with-prs";

const link = (n: number) => `https://github.com/acme/example-api/pull/${n}`;
const AT = "2026-11-26T15:04:00.000Z";

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
  board(b: Board) {
    this.readyState = 1;
    this.dispatchEvent(new MessageEvent("board", { data: JSON.stringify(b) }));
  }
}

const glance: Board["glance"] = {
  waiting: [
    // The glance says hot, but an explicit unhot in the map wins.
    { title: "Alpha (#11)", who: "QA", link: link(11), base: "develop", hot: true },
    // No hot on the item; an explicit hot in the map makes it hot.
    { title: "Bravo (#12)", who: "QA", link: link(12), base: "develop" },
    // A trailing slash on the row's link still matches the canonical key.
    { title: "Charlie (#13)", who: "QA", link: `${link(13)}/`, base: "develop" },
    { title: "Delta (#14)", who: "QA", link: link(14), base: "develop" },
  ],
  // On User's account, so it sits in Non-project PRs with the waiting entries.
  others: [{ title: "Echo (#15)", author: "alice", who: "Two approvals", link: link(15), hot: true }],
  tickets: [{ id: "PROJ-1", title: "Ticket A", status: "In Review", link: "https://linear.app/acme/issue/PROJ-1" }],
};
const hotMap: Board["hot"] = {
  [link(11)]: { hot: false, by: "cli", at: AT },
  [link(12)]: { hot: true, by: "user", at: AT },
  [link(13)]: { hot: true, by: "cli", at: AT },
};
const board = (hot: Board["hot"] = hotMap): Board => ({ updated_at: "2026-11-10T09:00:00.000Z", decisions: [], glance, hot });

// fetch: POST /__ab/hot goes to hotReply (deferred by the test); everything else fails like the other UI tests.
let hotReply: (r: Response) => void;
const fetchMock = vi.fn((url: string) =>
  url === "/__ab/hot" ? new Promise<Response>((resolve) => (hotReply = resolve)) : Promise.reject(new Error("no network in tests")),
);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", "");
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function renderPrs(b: Board = board()) {
  state.board = b;
  const { default: App } = await import("../src/App");
  const BoardAndPrs = withPrs(App);
  render(<BoardAndPrs />);
}

const section = () => within(prsPanel()).getByRole("heading", { name: /^Non-project PRs/ }).closest("section")!;
const titles = () => [...section().querySelectorAll("li.row .title")].map((t) => t.textContent);
const row = (title: string) => [...prsPanel().querySelectorAll<HTMLElement>("li.row")].find((r) => r.querySelector(".title")?.textContent === title)!;
const flame = (title: string) => within(row(title)).getByRole("button", { name: /^(Mark|Remove) HOT$/ });
const hotPosts = () => fetchMock.mock.calls.filter(([url]) => url === "/__ab/hot");

describe("isHot", () => {
  it("takes the hot map entry over the item's own hot, matching the canonical link in any case", () => {
    expect(isHot({ item: { link: link(1), hot: true } }, { [link(1)]: { hot: false, by: "cli", at: AT } })).toBe(false);
    expect(isHot({ item: { link: `${link(1)}/?x=1#y` } }, { [link(1).toLowerCase()]: { hot: true, by: "cli", at: AT } })).toBe(true);
    expect(isHot({ item: { link: link(1), hot: true } }, undefined)).toBe(true);
    expect(isHot({ item: { link: link(1) } }, { [link(2)]: { hot: true, by: "cli", at: AT } })).toBe(false);
  });

  it("sorts by it: an explicit hot first, an explicit unhot not", () => {
    const s = prSections(glance, new Map(), hotMap);
    expect(s.other.map((r) => r.item.title)).toEqual(["Bravo (#12)", "Charlie (#13)", "Echo (#15)", "Alpha (#11)", "Delta (#14)"]);
  });
});

describe("PRs tab HOT flame", () => {
  it("puts a flame on every PR row (not tickets), pressed by the hot map, and sorts and badges by it", async () => {
    await renderPrs();
    const flames = within(prsPanel()).getAllByRole("button", { name: /^(Mark|Remove) HOT$/ });
    expect(flames).toHaveLength(5);
    expect(titles()).toEqual(["Bravo (#12)", "Charlie (#13)", "Echo (#15)", "Alpha (#11)", "Delta (#14)"]);
    const pressed = (t: string) => flame(t).getAttribute("aria-pressed");
    expect(["Alpha (#11)", "Bravo (#12)", "Charlie (#13)", "Delta (#14)", "Echo (#15)"].map(pressed)).toEqual(["false", "true", "true", "false", "true"]);
    expect(flame("Alpha (#11)").getAttribute("aria-label")).toBe("Mark HOT");
    expect(flame("Bravo (#12)").getAttribute("aria-label")).toBe("Remove HOT");
    expect(flame("Bravo (#12)").className).toBe("hot-flame on");
    expect(flame("Alpha (#11)").className).toBe("hot-flame");
    // The explicit unhot wins over the glance's hot: true: no badge, no hot class.
    expect(row("Alpha (#11)").querySelector(".hot-badge")).toBeNull();
    expect(row("Alpha (#11)").classList.contains("hot")).toBe(false);
    // Who and when, in Eastern time, on the flame and the badge.
    expect(flame("Bravo (#12)").title).toBe("HOT by user Nov 26, 2026, 10:04 AM ET");
    expect(row("Bravo (#12)").querySelector<HTMLElement>(".hot-badge")!.title).toBe("HOT by user Nov 26, 2026, 10:04 AM ET");
    expect(flame("Alpha (#11)").title).toBe("HOT removed by cli Nov 26, 2026, 10:04 AM ET");
    expect(flame("Delta (#14)").title).toBe("Mark HOT");
    expect(row("Echo (#15)").querySelector(".hot-badge")?.textContent).toBe("HOT");
    expect(row("Echo (#15)").querySelector<HTMLElement>(".hot-badge")!.title).toBe("");
  });

  it("sits outside the row link, so a click never opens the PR", async () => {
    await renderPrs();
    const f = flame("Delta (#14)");
    expect(f.tagName).toBe("BUTTON");
    expect(f.getAttribute("type")).toBe("button");
    expect(f.closest("a")).toBeNull();
    const a = row("Delta (#14)").querySelector("a.item")!;
    const opened = vi.fn();
    a.addEventListener("click", opened);
    fireEvent.click(f);
    expect(opened).not.toHaveBeenCalled();
  });

  it("posts the exact body, shows the change at once, is disabled in flight, and the live board confirms it", async () => {
    await renderPrs();
    fireEvent.click(flame("Delta (#14)"));
    expect(hotPosts()).toHaveLength(1);
    const [url, init] = hotPosts()[0] as unknown as [string, RequestInit];
    expect(url).toBe("/__ab/hot");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ url: link(14), hot: true });
    // Optimistic: pressed, badged and first in its section before the reply.
    expect(flame("Delta (#14)").getAttribute("aria-pressed")).toBe("true");
    expect((flame("Delta (#14)") as HTMLButtonElement).disabled).toBe(true);
    expect(row("Delta (#14)").querySelector(".hot-badge")).not.toBeNull();
    expect(titles()).toEqual(["Bravo (#12)", "Charlie (#13)", "Delta (#14)", "Echo (#15)", "Alpha (#11)"]);

    const mark = { hot: true, by: "user", at: "2026-11-26T16:00:00.000Z" };
    await act(async () => hotReply(json(200, { ok: true, mark, changed: true })));
    expect(flame("Delta (#14)").getAttribute("aria-pressed")).toBe("true");
    expect((flame("Delta (#14)") as HTMLButtonElement).disabled).toBe(false);
    expect(flame("Delta (#14)").title).toBe("HOT by user Nov 26, 2026, 11:00 AM ET");

    // The live board brings the same mark: still hot, no reload, nothing else posted.
    act(() => FakeEventSource.instances[0].board(board({ ...hotMap, [link(14)]: mark })));
    expect(flame("Delta (#14)").getAttribute("aria-pressed")).toBe("true");
    expect(hotPosts()).toHaveLength(1);

    // A later unhot from the CLI, newer than the page's mark, wins.
    act(() => FakeEventSource.instances[0].board(board({ ...hotMap, [link(14)]: { hot: false, by: "cli", at: "2026-11-26T17:00:00.000Z" } })));
    expect(flame("Delta (#14)").getAttribute("aria-pressed")).toBe("false");
  });

  it("removes HOT with hot: false and the canonical URL for a row linked with a trailing slash", async () => {
    await renderPrs();
    fireEvent.click(flame("Charlie (#13)"));
    expect(JSON.parse((hotPosts()[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ url: link(13), hot: false });
    expect(flame("Charlie (#13)").getAttribute("aria-pressed")).toBe("false");
    expect(row("Charlie (#13)").querySelector(".hot-badge")).toBeNull();
  });

  it("rolls back and shows an inline error when the server refuses", async () => {
    await renderPrs();
    fireEvent.click(flame("Delta (#14)"));
    expect(flame("Delta (#14)").getAttribute("aria-pressed")).toBe("true");
    await act(async () => hotReply(json(502, { ok: false })));
    expect(flame("Delta (#14)").getAttribute("aria-pressed")).toBe("false");
    expect((flame("Delta (#14)") as HTMLButtonElement).disabled).toBe(false);
    expect(row("Delta (#14)").querySelector(".hot-badge")).toBeNull();
    expect(titles().at(-1)).toBe("Delta (#14)");
    expect(within(row("Delta (#14)")).getByRole("alert").textContent).toBe("Couldn't save HOT. Try again.");

    // A retry clears the error; an ok: false body is a failure too.
    fireEvent.click(flame("Delta (#14)"));
    expect(within(row("Delta (#14)")).queryByRole("alert")).toBeNull();
    await act(async () => hotReply(json(200, { ok: false })));
    expect(flame("Delta (#14)").getAttribute("aria-pressed")).toBe("false");
    expect(within(row("Delta (#14)")).getByRole("alert")).toBeTruthy();
  });

  it("is keyboard reachable as a plain button", async () => {
    await renderPrs();
    const f = flame("Delta (#14)");
    f.focus();
    expect(document.activeElement).toBe(f);
    expect(f.getAttribute("tabindex")).toBeNull();
  });
});
