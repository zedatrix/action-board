// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, Decision } from "../src/data/types";
import { FALLBACK_PATH } from "../src/delivery";
import { DecisionCard } from "../src/DecisionCard";
import { PRIORITY_PATH } from "../src/priority";
import { BOARD_PATH, EVENTS_PATH } from "../src/useLiveBoard";

const HOOK = "http://hook.test/priority";

const d = (id: string, extra: Partial<Decision> = {}): Decision => ({
  id,
  card_ref: null,
  context: `Context for ${id}, a fixture card in the priority tests.`,
  question: `Question ${id}?`,
  what_happens_after: "Something happens.",
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  created_at: "2026-11-10T09:00:00.000Z",
  ...extra,
});

const segments = (root: HTMLElement) => within(within(root).getByRole("group", { name: "Priority" })).getAllByRole("button") as HTMLButtonElement[];
const pressed = (root: HTMLElement) => segments(root).filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);

describe("DecisionCard: priority control", () => {
  afterEach(cleanup);

  it("shows three labeled segments in the top-right meta column, Medium pressed when the card has no priority", () => {
    const { container } = render(<DecisionCard decision={d("x")} index={1} onAnswer={vi.fn()} />);
    const card = container.querySelector<HTMLElement>("article.card")!;
    expect(segments(card).map((b) => b.textContent)).toEqual(["High", "Medium", "Low"]);
    expect(segments(card).map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    expect(card.dataset.priority).toBe("medium");
    // In .card-meta (inside .card-top), after the stamp and before Explain this better. No top-left row any more.
    const group = within(card).getByRole("group", { name: "Priority" });
    expect(group.className).toBe("priority");
    expect(group.parentElement!.className).toBe("card-meta");
    expect(group.parentElement!.parentElement!.className).toBe("card-top");
    expect(group.previousElementSibling!.className).toBe("stamp");
    expect(group.nextElementSibling!.textContent).toBe("Explain this better");
    expect(card.querySelector(".priority-row")).toBeNull();
    expect(card.firstElementChild!.className).toBe("context");
  });

  it("puts the control first in the meta column when there is no stamp", () => {
    const { container } = render(<DecisionCard decision={d("x", { created_at: undefined })} index={1} onAnswer={vi.fn()} />);
    const meta = container.querySelector(".card-top > .card-meta")!;
    expect(meta.firstElementChild!.className).toBe("priority");
    expect(meta.firstElementChild!.nextElementSibling!.className).toBe("clarify-btn");
  });

  it.each(["high", "medium", "low"] as const)("presses the %s segment and labels the badge with text", (level) => {
    const { container } = render(<DecisionCard decision={d("x", { priority: level })} index={1} onAnswer={vi.fn()} />);
    const card = container.querySelector<HTMLElement>("article.card")!;
    const label = { high: "High", medium: "Medium", low: "Low" }[level];
    expect(pressed(card)).toEqual([label]);
    expect(card.dataset.priority).toBe(level);
    const badge = card.querySelector(".priority-seg[aria-pressed='true']")!;
    expect(badge.textContent).toBe(label);
    expect(badge.classList.contains(`priority-${level}`)).toBe(true);
  });

  it("shows Medium for an invalid stored value", () => {
    const { container } = render(<DecisionCard decision={d("x", { priority: "urgent" as never })} index={1} onAnswer={vi.fn()} />);
    expect(pressed(container.querySelector<HTMLElement>("article.card")!)).toEqual(["Medium"]);
  });

  it("calls onPriority once for a segment that is not active, never for the active one", () => {
    const onPriority = vi.fn();
    const decision = d("x", { priority: "low" });
    const { container } = render(<DecisionCard decision={decision} index={1} onAnswer={vi.fn()} onPriority={onPriority} />);
    const [high, medium, low] = segments(container.querySelector<HTMLElement>("article.card")!);
    fireEvent.click(low);
    expect(onPriority).not.toHaveBeenCalled();
    fireEvent.click(high);
    expect(onPriority).toHaveBeenCalledTimes(1);
    expect(onPriority).toHaveBeenCalledWith(decision, "high");
    fireEvent.click(medium);
    expect(onPriority).toHaveBeenLastCalledWith(decision, "medium");
    expect(onPriority).toHaveBeenCalledTimes(2);
  });

  it("shows the error line only when the last save failed", () => {
    const r = render(<DecisionCard decision={d("x")} index={1} onAnswer={vi.fn()} />);
    expect(r.container.querySelector(".priority-error")).toBeNull();
    r.rerender(<DecisionCard decision={d("x")} index={1} onAnswer={vi.fn()} priorityError />);
    const err = within(r.container).getByRole("alert");
    expect(err.className).toBe("priority-error");
    expect(err.textContent).toBe("Could not save priority. Try again.");
    // Last line of the top-right meta column, after the Explain this better status lines.
    expect(err.parentElement!.className).toBe("card-meta");
    expect(err.parentElement!.parentElement!.className).toBe("card-top");
    expect(err.parentElement!.lastElementChild).toBe(err);
    r.rerender(<DecisionCard decision={d("x")} index={1} onAnswer={vi.fn()} priorityError clarify={{ status: "failed", http: 500 }} />);
    const meta = r.container.querySelector(".card-meta")!;
    expect([...meta.children].map((e) => e.className)).toEqual(["stamp", "priority", "clarify-btn", "clarify-error", "priority-error"]);
  });
});

// ---------- in the App ----------

const initial: Board = {
  updated_at: "2026-11-10T09:00:00.000Z",
  decisions: [
    d("m-old", { created_at: "2026-11-10T09:00:00.000Z" }),
    d("h-new", { priority: "high", created_at: "2026-11-10T11:00:00.000Z" }),
    d("l-old", { priority: "low", created_at: "2026-11-10T08:00:00.000Z" }),
    d("m-new", { priority: "medium", created_at: "2026-11-10T10:00:00.000Z" }),
    d("done", { priority: "high", answer: { answer: "yes", answer_label: "Yes", answered_by: "chat", answered_at: "2026-11-10T09:30:00.000Z" } }),
    d("h-undated", { priority: "high", created_at: undefined }),
  ],
  glance: { waiting: [], tickets: [] },
};

vi.mock("../src/data/board", () => ({ board: initial }));

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
}

// The priority route's reply: a status, a thrown network error, or a promise the test resolves later.
let priorityReply: () => Promise<Response>;
let calls: { url: string; init?: RequestInit }[];
const priorityCalls = () => calls.filter((c) => c.url === PRIORITY_PATH);

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", HOOK);
  vi.stubEnv("ACTION_BOARD_WEBHOOK_AUTH", "Bearer x");
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  calls = [];
  priorityReply = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === PRIORITY_PATH) return priorityReply();
      if (url === HOOK) return new Response("ok", { status: 200 });
      if (url === FALLBACK_PATH) return new Response(JSON.stringify({ status: 200 }), { status: 200 });
      if (url === "/__ab/delivery-log") return new Response(null, { status: 204 });
      if (url === BOARD_PATH) return new Response(JSON.stringify(initial), { status: 200 });
      throw new Error("no network in tests");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const card = (id: string) => document.querySelector<HTMLElement>(`[data-decision-id="${id}"]`)!;
const shownIds = () => [...document.querySelectorAll("article.card")].map((e) => e.getAttribute("data-decision-id"));
const indexes = () => [...document.querySelectorAll("article.card .idx")].map((e) => e.textContent);
// Each priority section in display order: its level, its heading text, and its cards.
const sections = () =>
  [...document.querySelectorAll<HTMLElement>(".queue > section.priority-section")].map((s) => ({
    level: s.dataset.level,
    heading: s.querySelector("h3.priority-heading")!.textContent!.replace(/\s+/g, " ").trim(),
    ids: [...s.querySelectorAll(".queue-group > article.card")].map((e) => e.getAttribute("data-decision-id")),
  }));
const sectionOf = (id: string) => card(id).closest<HTMLElement>("section.priority-section")!.dataset.level;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const seg = (id: string, label: string) => segments(card(id)).find((b) => b.textContent === label)!;
const tap = async (id: string, label: string) => {
  await act(async () => fireEvent.click(seg(id, label)));
  await flush();
};
const withDecision = (id: string, extra: Partial<Decision>): Board => ({
  ...initial,
  updated_at: new Date().toISOString(),
  decisions: initial.decisions.map((x) => (x.id === id ? { ...x, ...extra } : x)),
});

async function renderApp() {
  const { default: App } = await import("../src/App");
  render(<App />);
  const es = FakeEventSource.instances.at(-1)!;
  expect(es.url).toBe(EVENTS_PATH);
  act(() => es.open());
  return es;
}

describe("Needs you: priority order and taps", () => {
  it("sorts high, medium, low (oldest first in a level, undated last), numbers follow, count unchanged", async () => {
    await renderApp();
    expect(shownIds()).toEqual(["h-new", "h-undated", "m-old", "m-new", "l-old"]);
    expect(indexes()).toEqual(["1", "2", "3", "4", "5"]);
    expect(document.querySelector(".needs-you h2")!.textContent).toBe("Needs you 5");
    expect(pressed(card("m-old"))).toEqual(["Medium"]);
  });

  it("shows one labeled section per level, High, Medium, Low, with counts, numbers running on across them", async () => {
    await renderApp();
    expect(sections()).toEqual([
      { level: "high", heading: "High 2", ids: ["h-new", "h-undated"] },
      { level: "medium", heading: "Medium 2", ids: ["m-old", "m-new"] },
      { level: "low", heading: "Low 1", ids: ["l-old"] },
    ]);
    for (const s of document.querySelectorAll<HTMLElement>("section.priority-section")) {
      const h = s.querySelector("h3.priority-heading")!;
      expect(s.getAttribute("aria-labelledby")).toBe(h.id);
      expect(h.querySelector(".n")!.textContent).toBe(String(s.querySelectorAll("article.card").length));
    }
    expect(screen.getByRole("region", { name: "High 2" })).toBeTruthy();
    // Every card is in a section; the count in the main header is the total; one End of queue marker, at the end.
    expect(document.querySelectorAll(".queue article.card")).toHaveLength(5);
    expect(document.querySelectorAll(".queue > :not(section.priority-section)")).toHaveLength(0);
    expect(indexes()).toEqual(["1", "2", "3", "4", "5"]);
    expect(card("m-old").querySelector(".idx")!.textContent).toBe("3");
    expect(document.querySelectorAll(".queue-end")).toHaveLength(1);
    expect(document.querySelector(".queue")!.nextElementSibling!.className).toBe("queue-end");
  });

  it("renders no section for a level with no cards", async () => {
    const es = await renderApp();
    act(() =>
      es.board({
        ...initial,
        updated_at: new Date().toISOString(),
        decisions: initial.decisions.map((x) => ({ ...x, priority: undefined })),
      }),
    );
    expect(sections()).toEqual([{ level: "medium", heading: "Medium 5", ids: ["l-old", "m-old", "m-new", "h-new", "h-undated"] }]);
    expect(document.querySelector(".needs-you h2")!.textContent).toBe("Needs you 5");
    expect(screen.queryByRole("heading", { name: /^High/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^Low/ })).toBeNull();

    act(() => es.board({ ...initial, updated_at: new Date().toISOString(), decisions: [] }));
    expect(sections()).toEqual([]);
    expect(screen.getByText("Nothing needs you right now.")).toBeTruthy();
  });

  it("a tap moves the card to the other section at once, and back when the save fails", async () => {
    let fail!: () => void;
    priorityReply = () => new Promise((_r, reject) => (fail = () => reject(new TypeError("Failed to fetch"))));
    await renderApp();
    await tap("m-old", "Low");
    expect(sectionOf("m-old")).toBe("low");
    expect(sections().map((s) => s.heading)).toEqual(["High 2", "Medium 1", "Low 2"]);
    // m-old (09:00) is newer than l-old (08:00): it goes second in Low, and is now card 5.
    expect(sections()[2].ids).toEqual(["l-old", "m-old"]);
    expect(card("m-old").querySelector(".idx")!.textContent).toBe("5");

    await act(async () => fail());
    await flush();
    expect(sectionOf("m-old")).toBe("medium");
    expect(sections().map((s) => s.heading)).toEqual(["High 2", "Medium 2", "Low 1"]);
    expect(card("m-old").querySelector(".idx")!.textContent).toBe("3");
    expect(within(card("m-old")).getByRole("alert").textContent).toBe("Could not save priority. Try again.");
  });

  it("the last card of a level moving out removes that section; moving back brings it back", async () => {
    await renderApp();
    await tap("l-old", "High");
    expect(sections().map((s) => s.heading)).toEqual(["High 3", "Medium 2"]);
    expect(sections()[0].ids).toEqual(["l-old", "h-new", "h-undated"]);
    await tap("l-old", "Low");
    // The first save is done, so a second tap goes through.
    expect(sections().map((s) => s.heading)).toEqual(["High 2", "Medium 2", "Low 1"]);
  });

  it("a tap shows the new level and re-sorts at once, POSTs once, ignores taps while in flight, and the board wins after", async () => {
    let resolve!: (r: Response) => void;
    priorityReply = () => new Promise((r) => (resolve = r));
    const es = await renderApp();

    await tap("m-new", "High");
    expect(pressed(card("m-new"))).toEqual(["High"]);
    expect(card("m-new").dataset.priority).toBe("high");
    // m-new (10:00) is older than h-new (11:00), so it leads.
    expect(shownIds()).toEqual(["m-new", "h-new", "h-undated", "m-old", "l-old"]);
    expect(card("m-new").querySelector(".idx")!.textContent).toBe("1");
    expect(priorityCalls()).toHaveLength(1);
    const call = priorityCalls()[0];
    expect(call.init!.method).toBe("POST");
    expect(new Headers(call.init!.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(call.init!.body))).toStrictEqual({ id: "m-new", priority: "high" });

    // In flight: more taps on that card are ignored; another card still works.
    await tap("m-new", "Low");
    expect(priorityCalls()).toHaveLength(1);
    expect(pressed(card("m-new"))).toEqual(["High"]);

    await act(async () => resolve(new Response(JSON.stringify({ ok: true, priority: "high" }), { status: 200 })));
    await flush();
    expect(pressed(card("m-new"))).toEqual(["High"]);
    expect(document.querySelector(".priority-error")).toBeNull();

    // The live board catches up: the override is dropped, so a later board value shows as is.
    act(() => es.board(withDecision("m-new", { priority: "high" })));
    expect(pressed(card("m-new"))).toEqual(["High"]);
    act(() => es.board(withDecision("m-new", { priority: "low" })));
    expect(pressed(card("m-new"))).toEqual(["Low"]);
    expect(shownIds().at(-1)).toBe("m-new");
  });

  it("keeps the tapped level until the board shows it when the save returns first", async () => {
    const es = await renderApp();
    await tap("l-old", "High");
    expect(priorityCalls()).toHaveLength(1);
    // Saved, but the board has not pushed it yet: still High, still first.
    act(() => es.board(withDecision("m-old", { question: "Question m-old, reworded?" })));
    expect(pressed(card("l-old"))).toEqual(["High"]);
    expect(shownIds()[0]).toBe("l-old");
    act(() => es.board(withDecision("l-old", { priority: "high" })));
    expect(pressed(card("l-old"))).toEqual(["High"]);
  });

  it("tapping the active level does nothing", async () => {
    await renderApp();
    await tap("m-old", "Medium");
    await tap("h-new", "High");
    expect(priorityCalls()).toHaveLength(0);
    expect(shownIds()).toEqual(["h-new", "h-undated", "m-old", "m-new", "l-old"]);
  });

  it.each([
    ["a non-2xx reply", async () => new Response(JSON.stringify({ ok: false }), { status: 409 })],
    ["a network error", async () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("on %s it goes back to the board's level and shows the error; the next tap clears it", async (_what, reply) => {
    priorityReply = reply as () => Promise<Response>;
    await renderApp();
    await tap("l-old", "High");
    await flush();
    expect(pressed(card("l-old"))).toEqual(["Low"]);
    expect(shownIds().at(-1)).toBe("l-old");
    const err = within(card("l-old")).getByRole("alert");
    expect(err.textContent).toBe("Could not save priority. Try again.");
    expect(err.className).toBe("priority-error");
    expect(document.querySelectorAll(".priority-error")).toHaveLength(1);

    priorityReply = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    await tap("l-old", "Medium");
    expect(card("l-old").querySelector(".priority-error")).toBeNull();
    expect(pressed(card("l-old"))).toEqual(["Medium"]);
    expect(priorityCalls()).toHaveLength(2);
  });

  it("a priority change does not clear Rewording...; a real rewording still does", async () => {
    const es = await renderApp();
    const explain = within(card("m-old")).getByRole("button", { name: "Explain this better" });
    await act(async () => fireEvent.click(explain));
    await flush();
    await flush();
    const status = () => card("m-old").querySelector(".clarify-status")?.textContent ?? null;
    expect(status()).toBe("Rewording...");

    // Tapped in the app, then pushed by the board: Rewording... stays.
    await tap("m-old", "High");
    expect(status()).toBe("Rewording...");
    act(() => es.board(withDecision("m-old", { priority: "high" })));
    expect(status()).toBe("Rewording...");
    expect(pressed(card("m-old"))).toEqual(["High"]);

    act(() => es.board(withDecision("m-old", { priority: "high", question: "Question m-old, in plain words?" })));
    expect(status()).toBeNull();
  });
});
