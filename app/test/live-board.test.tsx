// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";
import { STORAGE_KEY } from "../src/delivery";
import { BOARD_PATH, EVENTS_PATH, POLL_MS } from "../src/useLiveBoard";

const d = (id: string, extra: object = {}) => ({
  id,
  card_ref: null,
  question: `Question ${id}?`,
  what_happens_after: "Something happens.",
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  created_at: "2026-11-10T09:00:00.000Z",
  ...extra,
});
const glance = {
  waiting: [
    { title: "Analytics dashboard (#101)", who: "Blake", link: "https://github.com/acme/example/pull/101" },
    { title: "chat alerts (#102)", who: "Two approvals", link: "https://github.com/acme/example/pull/102" },
  ],
  tickets: [],
};
const initial: Board = { updated_at: "2026-11-10T09:00:00.000Z", decisions: [d("one"), d("two")], glance };

vi.mock("../src/data/board", () => ({ board: initial }));

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
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  board(b: Board) {
    this.dispatchEvent(new MessageEvent("board", { data: JSON.stringify(b) }));
  }
  fail(closed: boolean) {
    this.readyState = closed ? 2 : 0;
    this.dispatchEvent(new Event("error"));
  }
}

let served: Board;
let fetchMock: ReturnType<typeof vi.fn>;
const boardFetches = () => fetchMock.mock.calls.filter(([url]) => url === BOARD_PATH).length;

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", "");
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  served = initial;
  fetchMock = vi.fn(async (url: string) => {
    if (url === BOARD_PATH) return new Response(JSON.stringify(served), { status: 200 });
    throw new Error("no network in tests");
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const shownIds = () => [...document.querySelectorAll("[data-decision-id]")].map((e) => e.getAttribute("data-decision-id"));

async function renderApp() {
  const { default: App } = await import("../src/App");
  render(<App />);
  const es = FakeEventSource.instances.at(-1)!;
  expect(es.url).toBe(EVENTS_PATH);
  act(() => es.open());
  return es;
}

describe("live board (useLiveBoard in App)", () => {
  it("starts from the bundled board and follows board events", async () => {
    const es = await renderApp();
    expect(shownIds()).toEqual(["one", "two"]);

    act(() => es.board({ ...initial, decisions: [...initial.decisions, d("three")] }));
    expect(shownIds()).toEqual(["one", "two", "three"]);

    const answer = { answer: "yes", answer_label: "Yes", answered_by: "chat" as const, answered_at: "2026-11-10T10:00:00.000Z" };
    act(() => es.board({ ...initial, decisions: [d("one", { answer }), d("two"), d("three")] }));
    expect(shownIds()).toEqual(["two", "three"]);
    expect(boardFetches()).toBe(0);
  });

  it("keeps a typed, unsent answer in another card across an update", async () => {
    const es = await renderApp();
    const input = within(document.querySelector<HTMLElement>('[data-decision-id="two"]')!).getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "half a thought" } });
    act(() => es.board({ ...initial, updated_at: "2026-11-10T09:30:00.000Z", decisions: [d("two"), d("four")] }));
    expect(shownIds()).toEqual(["two", "four"]);
    expect((within(document.querySelector<HTMLElement>('[data-decision-id="two"]')!).getByRole("textbox") as HTMLInputElement).value).toBe(
      "half a thought",
    );
  });

  it("keeps typed Message your assistant text in two glance items across a live update that reorders them", async () => {
    const es = await renderApp();
    const rootOf = (id: string) => [...document.querySelectorAll<HTMLElement>("[data-item-id]")].find((e) => e.dataset.itemId === id)!;
    const pr101 = "https://github.com/acme/example/pull/101";
    const pr102 = "https://github.com/acme/example/pull/102";
    const open = (id: string, text: string) => {
      fireEvent.click(within(rootOf(id)).getByRole("button", { name: /^Message your assistant about/ }));
      fireEvent.change(within(rootOf(id)).getByRole("textbox", { name: /^Message to your assistant/ }), { target: { value: text } });
    };
    open(pr101, "about 101");
    open(pr102, "about 102");
    const focused = within(rootOf(pr102)).getByRole("textbox", { name: /^Message to your assistant/ });
    focused.focus();

    // A new board object: decisions and waiting items reordered, one added in front, titles unchanged.
    act(() =>
      es.board({
        updated_at: "2026-11-10T09:30:00.000Z",
        decisions: [d("zero"), d("two"), d("one")],
        glance: { ...glance, waiting: [{ title: "New (#1)", who: "X", link: "https://github.com/x/y/pull/1" }, glance.waiting[1], glance.waiting[0]] },
      }),
    );
    expect(shownIds()).toEqual(["zero", "two", "one"]);
    const field = (id: string) => within(rootOf(id)).queryByRole("textbox", { name: /^Message to your assistant/ }) as HTMLTextAreaElement | null;
    expect(field(pr101)!.value).toBe("about 101");
    expect(field(pr102)!.value).toBe("about 102");
    expect(field(pr102)).toBe(focused);
    expect(document.activeElement).toBe(focused);
    // Only the two composers that were opened are open.
    expect(document.querySelectorAll("textarea")).toHaveLength(2);
    expect(field("https://github.com/x/y/pull/1")).toBeNull();
  });

  it("ignores events that are not a board", async () => {
    const es = await renderApp();
    act(() => es.dispatchEvent(new MessageEvent("board", { data: "{not json" })));
    act(() => es.dispatchEvent(new MessageEvent("board", { data: '{"decisions":"nope"}' })));
    expect(shownIds()).toEqual(["one", "two"]);
  });

  it("polls /__ab/board every 2s while the stream is down, and stops once it is back", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const es = await renderApp();
    served = { ...initial, decisions: [d("one"), d("two"), d("polled")] };

    await act(async () => es.fail(false));
    expect(boardFetches()).toBe(1);
    expect(shownIds()).toEqual(["one", "two", "polled"]);

    served = { ...initial, decisions: [d("polled")] };
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS)));
    expect(boardFetches()).toBe(2);
    expect(shownIds()).toEqual(["polled"]);

    act(() => es.open());
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS * 3)));
    expect(boardFetches()).toBe(2);
  });

  it("reopens a refused stream from the poll tick", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const es = await renderApp();
    await act(async () => es.fail(true));
    expect(FakeEventSource.instances).toHaveLength(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS)));
    expect(FakeEventSource.instances).toHaveLength(2);
    const again = FakeEventSource.instances[1];
    act(() => again.open());
    act(() => again.board({ ...initial, decisions: [d("back")] }));
    expect(shownIds()).toEqual(["back"]);
  });

  it("drops a local app answer once a live update shows the file answered it", async () => {
    const es = await renderApp();
    await act(async () => fireEvent.click(within(document.querySelector<HTMLElement>('[data-decision-id="one"]')!).getByRole("button", { name: "Yes" })));
    expect(Object.keys(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!))).toEqual(["one"]);
    const answer = { answer: "yes", answer_label: "Yes", answered_by: "app" as const, answered_at: "2026-11-10T10:00:00.000Z" };
    await act(async () => es.board({ ...initial, decisions: [d("one", { answer }), d("two")] }));
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({});
    expect(shownIds()).toEqual(["two"]);
  });

  it("changes a card's added/updated stamp when a pushed board has a newer updated_at, without a reload", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T20:00:00.000Z"));
    const es = await renderApp();
    const stamp = () => document.querySelector('[data-decision-id="one"] .stamp')?.textContent;
    const input = within(document.querySelector<HTMLElement>('[data-decision-id="one"]')!).getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "typed before the update" } });
    expect(stamp()).toBe("added 4:00 AM");

    act(() => es.board({ ...initial, updated_at: "2026-11-10T19:40:00.000Z", decisions: [d("one", { updated_at: "2026-11-10T19:40:00.000Z" }), d("two")] }));
    expect(stamp()).toBe("updated 2:40 PM");
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe("typed before the update");
    expect(boardFetches()).toBe(0);
  });

  it("refetches when the window regains focus", async () => {
    await renderApp();
    served = { ...initial, decisions: [d("focused")] };
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(boardFetches()).toBe(1);
    expect(shownIds()).toEqual(["focused"]);
  });
});
