// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, Decision } from "../src/data/types";
import {
  buildClarifyPayload,
  createDelivery,
  FALLBACK_PATH,
  MESSAGES_KEY,
  STORAGE_KEY,
  type DeliveryReport,
  type KeyValueStorage,
} from "../src/delivery";
import { BOARD_PATH, EVENTS_PATH } from "../src/useLiveBoard";

const HOOK = "http://hook.test/clarify";
const AUTH = "Bearer clarify  test==";
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

const d = (id: string, extra: object = {}): Decision => ({
  id,
  card_ref: null,
  context: `Context for ${id}, a fixture card in the clarify tests.`,
  question: `Question ${id}?`,
  what_happens_after: "Something happens.",
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  created_at: "2026-11-10T09:00:00.000Z",
  ...extra,
});
const initial: Board = {
  updated_at: "2026-11-10T09:00:00.000Z",
  decisions: [d("one"), d("two", { multiSelect: true }), d("bare", { context: undefined })],
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

// What the mock network does: the direct POST answers with a status or throws (a CORS block),
// and the dev-server fallback reports the receiver's status.
let direct: number | "cors";
let fallback: number | null;
let calls: { url: string; init?: RequestInit }[];
const webhookCalls = () => calls.filter((c) => c.url === HOOK || c.url === FALLBACK_PATH);
const logCalls = () => calls.filter((c) => c.url === "/__ab/delivery-log").map((c) => JSON.parse(String(c.init!.body)));

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", HOOK);
  vi.stubEnv("ACTION_BOARD_WEBHOOK_AUTH", AUTH);
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  direct = 200;
  fallback = 200;
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === HOOK) {
        if (direct === "cors") throw new TypeError("Failed to fetch");
        return new Response("ok", { status: direct });
      }
      if (url === FALLBACK_PATH) return new Response(JSON.stringify({ status: fallback }), { status: fallback === null ? 502 : 200 });
      if (url === "/__ab/delivery-log") return new Response(null, { status: 204 });
      if (url === BOARD_PATH) return new Response(JSON.stringify(initial), { status: 200 });
      throw new Error("no network in tests");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const card = (id: string) => document.querySelector<HTMLElement>(`[data-decision-id="${id}"]`);
const shownIds = () => [...document.querySelectorAll("[data-decision-id]")].map((e) => e.getAttribute("data-decision-id"));
const button = (id: string) => within(card(id)!).getByRole("button", { name: "Explain this better" }) as HTMLButtonElement;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

async function renderApp() {
  const { default: App } = await import("../src/App");
  render(<App />);
  const es = FakeEventSource.instances.at(-1)!;
  expect(es.url).toBe(EVENTS_PATH);
  act(() => es.open());
  return es;
}

async function click(id: string) {
  await act(async () => fireEvent.click(button(id)));
  await flush();
}

describe("Explain this better", () => {
  it("is on every open card, top right in the question row after the stamp, before the answer buttons", async () => {
    await renderApp();
    expect(shownIds()).toEqual(["one", "two", "bare"]);
    for (const id of shownIds()) {
      const b = button(id!);
      expect(b.textContent).toBe("Explain this better");
      expect(b.disabled).toBe(false);
      const meta = b.parentElement!;
      expect(meta.className).toBe("card-meta");
      expect(meta.parentElement!.className).toBe("card-top");
      expect(meta.previousElementSibling!.className).toBe("question");
      // Stamp, then the priority control, then this button.
      expect(b.previousElementSibling!.className).toBe("priority");
      expect(b.previousElementSibling!.previousElementSibling!.className).toBe("stamp");
      expect(card(id!)!.querySelector(".options")!.contains(b)).toBe(false);
      const order = [...card(id!)!.querySelectorAll("button, input")].map((e) => e.textContent || e.getAttribute("aria-label"));
      expect(order.slice(0, 4)).toEqual(["High", "Medium", "Low", "Explain this better"]);
      expect(order.slice(1)).toContain("No");
      // The answer controls, then "Not relevant anymore" alone in the card footer.
      expect(order.slice(-3)).toEqual(["Your own answer", "Send answer", "Not relevant anymore"]);
    }
  });

  it("sits top right under the priority control when the card has no stamp", async () => {
    const { DecisionCard } = await import("../src/DecisionCard");
    const { container } = render(<DecisionCard decision={d("nostamp", { created_at: undefined })} index={1} onAnswer={vi.fn()} />);
    const meta = container.querySelector(".card-top > .card-meta")!;
    expect(meta.querySelector(".stamp")).toBeNull();
    expect(meta.firstElementChild!.className).toBe("priority");
    const b = meta.firstElementChild!.nextElementSibling!;
    expect(b.textContent).toBe("Explain this better");
    expect(b.tagName).toBe("BUTTON");
  });

  it("POSTs one decision.clarify payload directly with the Authorization header", async () => {
    await renderApp();
    await click("one");
    expect(webhookCalls()).toHaveLength(1);
    const { url, init } = webhookCalls()[0];
    expect(url).toBe(HOOK);
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>).Authorization).toBe(AUTH);
    const body = JSON.parse(String(init!.body));
    expect(Object.keys(body)).toEqual(["event", "decision_id", "question", "context", "clicked_at"]);
    expect(body).toEqual({
      event: "decision.clarify",
      decision_id: "one",
      question: "Question one?",
      context: "Context for one, a fixture card in the clarify tests.",
      clicked_at: body.clicked_at,
    });
    expect(body.clicked_at).toMatch(ISO);
    expect(Math.abs(Date.parse(body.clicked_at) - Date.now())).toBeLessThan(5000);
  });

  it("sends context as an empty string when the card has none", async () => {
    await renderApp();
    await click("bare");
    expect(JSON.parse(String(webhookCalls()[0].init!.body))).toMatchObject({ decision_id: "bare", context: "" });
  });

  it("a double click sends one POST", async () => {
    await renderApp();
    let release!: () => void;
    direct = 200;
    const gate = new Promise<void>((r) => (release = r));
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (url === HOOK) await gate;
      return base(url as string, init);
    });
    act(() => {
      fireEvent.click(button("one"));
      fireEvent.click(button("one"));
    });
    fireEvent.click(button("one"));
    expect(button("one").disabled).toBe(true);
    release();
    await flush();
    await click("one"); // Rewording: disabled, nothing more is sent.
    expect(webhookCalls()).toHaveLength(1);
  });

  it("does not answer, hide or store anything; shows Rewording... with the button disabled", async () => {
    await renderApp();
    await click("one");
    expect(shownIds()).toEqual(["one", "two", "bare"]);
    expect(window.localStorage.getItem(STORAGE_KEY) ?? "{}").toBe("{}");
    expect(window.localStorage.getItem(MESSAGES_KEY) ?? "{}").toBe("{}");
    expect(within(card("one")!).getByRole("status").textContent).toBe("Rewording...");
    expect(card("one")!.querySelector(".card-top > .card-meta > .clarify-status")).toBeTruthy();
    expect(card("one")!.querySelector(".card-meta > .clarify-status")!.previousElementSibling).toBe(button("one"));
    expect(button("one").disabled).toBe(true);
    expect(within(card("two")!).queryByRole("status")).toBeNull();
    expect(button("two").disabled).toBe(false);
    expect(screen.queryByText(/^Answered/)).toBeNull();
  });

  it("keeps Rewording... while the board changes only other decisions, clears it when that decision changes", async () => {
    const es = await renderApp();
    await click("one");
    // Another card changes, the order changes and a card is added: still rewording.
    act(() => es.board({ ...initial, updated_at: "2026-11-10T10:00:00.000Z", decisions: [d("two", { question: "New two?" }), d("three"), d("one")] }));
    expect(shownIds()).toEqual(["two", "three", "one"]);
    expect(within(card("one")!).getByRole("status").textContent).toBe("Rewording...");
    expect(button("one").disabled).toBe(true);
    // ab raise on the same id: new question and updated_at.
    act(() =>
      es.board({
        ...initial,
        updated_at: "2026-11-10T10:05:00.000Z",
        decisions: [d("two"), d("one", { question: "Clearer question one?", updated_at: "2026-11-10T10:05:00.000Z" })],
      }),
    );
    expect(within(card("one")!).queryByRole("status")).toBeNull();
    expect(card("one")!.textContent).toContain("Clearer question one?");
    expect(button("one").disabled).toBe(false);
  });

  it("clears Rewording... when the decision is answered in the file or dropped", async () => {
    const es = await renderApp();
    await click("one");
    await click("two");
    const answer = { answer: "yes", answer_label: "Yes", answered_by: "chat" as const, answered_at: "2026-11-10T10:00:00.000Z" };
    act(() => es.board({ ...initial, decisions: [d("one", { answer }), d("bare")] }));
    expect(shownIds()).toEqual(["bare"]);
    // Both come back unchanged (a hand edit): the state was dropped, so the buttons are enabled.
    act(() => es.board(initial));
    expect(button("one").disabled).toBe(false);
    expect(button("two").disabled).toBe(false);
    expect(document.querySelector(".clarify-status")).toBeNull();
  });

  it("on a non-2xx after the retries shows the HTTP error and re-enables the button; a later click clears it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    direct = 502;
    await renderApp();
    await act(async () => fireEvent.click(button("one")));
    await act(async () => void (await vi.advanceTimersByTimeAsync(2500)));
    expect(webhookCalls()).toHaveLength(3);
    expect(within(card("one")!).getByRole("alert").textContent).toBe("Could not send (HTTP 502). Try again.");
    expect(within(card("one")!).getByRole("alert").parentElement!.className).toBe("card-meta");
    expect(card("one")!.querySelector(".card-top > .card-meta > .clarify-error")).toBeTruthy();
    expect(within(card("one")!).queryByRole("status")).toBeNull();
    expect(button("one").disabled).toBe(false);
    expect(shownIds()).toEqual(["one", "two", "bare"]);
    expect(window.localStorage.getItem(STORAGE_KEY) ?? "{}").toBe("{}");

    direct = 200;
    await act(async () => fireEvent.click(button("one")));
    expect(within(card("one")!).queryByRole("alert")).toBeNull();
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(webhookCalls()).toHaveLength(4);
    expect(within(card("one")!).getByRole("status").textContent).toBe("Rewording...");
  });

  it("on a network error everywhere shows the plain error", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    direct = "cors";
    fallback = null;
    await renderApp();
    await act(async () => fireEvent.click(button("one")));
    await act(async () => void (await vi.advanceTimersByTimeAsync(2500)));
    expect(within(card("one")!).getByRole("alert").textContent).toBe("Could not send. Try again.");
    expect(button("one").disabled).toBe(false);
  });

  it("falls back to /__ab/webhook when the direct POST throws (CORS), like answers", async () => {
    direct = "cors";
    fallback = 201;
    await renderApp();
    await click("one");
    expect(webhookCalls().map((c) => c.url)).toEqual([HOOK, FALLBACK_PATH]);
    const fb = webhookCalls()[1].init!;
    expect((fb.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(String(fb.body))).toMatchObject({ event: "decision.clarify", decision_id: "one" });
    expect(within(card("one")!).getByRole("status").textContent).toBe("Rewording...");
    expect(logCalls()).toEqual([{ event: "decision.clarify", decision_id: "one", http: 201, via: "fallback", attempt: 1, status: "delivered", at: expect.stringMatching(ISO) }]);
  });

  it("without a webhook URL goes straight to the fallback; a 503 there is a failure", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", "");
    fallback = 503;
    await renderApp();
    await act(async () => fireEvent.click(button("one")));
    await act(async () => void (await vi.advanceTimersByTimeAsync(2500)));
    expect(webhookCalls().map((c) => c.url)).toEqual([FALLBACK_PATH, FALLBACK_PATH, FALLBACK_PATH]);
    expect(within(card("one")!).getByRole("alert").textContent).toBe("Could not send (HTTP 503). Try again.");

    fallback = 200;
    await act(async () => fireEvent.click(button("one")));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(within(card("one")!).getByRole("status").textContent).toBe("Rewording...");
  });
});

describe("delivery.clarify", () => {
  const memory = (): KeyValueStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };
  const NOW = new Date("2026-11-10T12:34:56.789Z");

  it("builds the payload from the current question and context", () => {
    expect(buildClarifyPayload(d("x"), NOW)).toEqual({
      event: "decision.clarify",
      decision_id: "x",
      question: "Question x?",
      context: "Context for x, a fixture card in the clarify tests.",
      clicked_at: "2026-11-10T12:34:56.789Z",
    });
    expect(buildClarifyPayload(d("x", { context: undefined }), NOW).context).toBe("");
  });

  it("retries like answers, reports each attempt without text, stores nothing, and resolves with the outcome", async () => {
    const storage = memory();
    const reports: DeliveryReport[] = [];
    const statuses = [500, 429, 202];
    const slept: number[] = [];
    const delivery = createDelivery({
      fetch: vi.fn(async () => new Response(null, { status: statuses.shift()! })) as unknown as typeof fetch,
      sleep: async (ms) => void slept.push(ms),
      storage,
      webhookUrl: HOOK,
      webhookAuth: AUTH,
      fallbackUrl: FALLBACK_PATH,
      now: () => NOW,
      report: (r) => reports.push(r),
    });
    expect(await delivery.clarify(buildClarifyPayload(d("x"), NOW))).toEqual({ ok: true, http: 202, via: "direct" });
    expect(slept).toEqual([500, 1500]);
    expect(reports.map((r) => [r.attempt, r.http, r.status])).toEqual([
      [1, 500, "retrying"],
      [2, 429, "retrying"],
      [3, 202, "delivered"],
    ]);
    expect(Object.keys(reports[0])).toEqual(["event", "decision_id", "http", "via", "attempt", "status", "at"]);
    expect(JSON.stringify(reports)).not.toContain("Question x");
    expect(storage.data.size).toBe(0);
  });

  it("resolves not ok with the last status after three failures", async () => {
    const delivery = createDelivery({
      fetch: vi.fn(async () => new Response(null, { status: 502 })) as unknown as typeof fetch,
      sleep: async () => undefined,
      storage: memory(),
      webhookUrl: HOOK,
      fallbackUrl: FALLBACK_PATH,
      report: () => undefined,
    });
    expect(await delivery.clarify(buildClarifyPayload(d("x"), NOW))).toEqual({ ok: false, http: 502, via: "direct" });
  });
});
