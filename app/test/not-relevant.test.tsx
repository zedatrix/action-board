// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, Decision } from "../src/data/types";
import {
  buildNotRelevantPayload,
  CLEAR_PATH,
  createDelivery,
  FALLBACK_PATH,
  MESSAGES_KEY,
  STORAGE_KEY,
  type DeliveryReport,
  type KeyValueStorage,
} from "../src/delivery";
import { BOARD_PATH, EVENTS_PATH } from "../src/useLiveBoard";

const HOOK = "http://hook.test/not-relevant";
const AUTH = "Bearer not relevant  test==";
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const LABEL = "Not relevant anymore";

const d = (id: string, extra: object = {}): Decision => ({
  id,
  card_ref: null,
  context: `Context for ${id}, a fixture card in the not relevant tests.`,
  question: `Secret question ${id}?`,
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
  decisions: [d("one", { card_ref: "https://example.com/pr/1" }), d("two", { multiSelect: true, card_ref: "PROJ-12 see notes" }), d("bare")],
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

// The mock network: the direct POST answers with a status or throws (a CORS block), the dev-server fallback
// reports the receiver's status, and /__ab/clear answers with a status or throws.
let direct: number | "cors";
let fallback: number | null;
let clear: number | "down";
let calls: { url: string; init?: RequestInit }[];
const webhookCalls = () => calls.filter((c) => c.url === HOOK || c.url === FALLBACK_PATH);
const clearCalls = () => calls.filter((c) => c.url === CLEAR_PATH);
const logCalls = () => calls.filter((c) => c.url === "/__ab/delivery-log");

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", HOOK);
  vi.stubEnv("ACTION_BOARD_WEBHOOK_AUTH", AUTH);
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  direct = 200;
  fallback = 200;
  clear = 200;
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
      if (url === CLEAR_PATH) {
        if (clear === "down") throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ ok: clear === 200 }), { status: clear });
      }
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
const button = (id: string) => within(card(id)!).getByRole("button", { name: LABEL }) as HTMLButtonElement;
const needsYou = () => document.querySelector(".needs-you .kicker .n")!.textContent;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

async function renderApp() {
  const { default: App } = await import("../src/App");
  render(<App />);
  const es = FakeEventSource.instances.at(-1)!;
  expect(es.url).toBe(EVENTS_PATH);
  act(() => es.open());
  return es;
}

async function tap(id: string) {
  await act(async () => fireEvent.click(button(id)));
  await flush();
}

// Runs a tap whose webhook fails all three tries (fake timers skip the retry waits).
async function tapAndWait(id: string) {
  await act(async () => fireEvent.click(button(id)));
  await act(async () => void (await vi.advanceTimersByTimeAsync(2500)));
}

describe("Not relevant anymore", () => {
  it("is on every open card with that exact text, at the bottom right of the card footer, away from the answers", async () => {
    await renderApp();
    expect(shownIds()).toEqual(["one", "two", "bare"]);
    for (const id of ["one", "two", "bare"]) {
      const c = card(id)!;
      const b = button(id);
      expect(b.textContent).toBe(LABEL);
      expect(b.className).toBe("not-relevant-btn");
      expect(b.getAttribute("type")).toBe("button");
      expect(b.disabled).toBe(false);
      // article > .card-foot > .not-relevant > button, the footer being the card's last child.
      const group = b.parentElement!;
      expect(group.className).toBe("not-relevant");
      expect(group.lastElementChild).toBe(b);
      const foot = group.parentElement!;
      expect(foot.className).toBe("card-foot");
      expect(foot.parentElement).toBe(c);
      expect(c.lastElementChild).toBe(foot);
      expect(foot.lastElementChild).toBe(group);
      expect(c.querySelector(".card-meta")!.contains(b)).toBe(false);
      expect(c.querySelector(".options")!.contains(b)).toBe(false);
      expect(c.querySelector(".custom")!.contains(b)).toBe(false);
      expect(within(c).getAllByRole("button", { name: LABEL })).toHaveLength(1);
    }
    // The evidence link sits on the left of the same row; without a card_ref the control is alone there.
    expect([...card("one")!.querySelector(".card-foot")!.children].map((e) => e.className)).toEqual(["evidence", "not-relevant"]);
    expect([...card("two")!.querySelector(".card-foot")!.children].map((e) => e.className)).toEqual(["evidence", "not-relevant"]);
    expect([...card("bare")!.querySelector(".card-foot")!.children].map((e) => e.className)).toEqual(["not-relevant"]);
  });

  it("sends exactly one decision.not_relevant POST, and only then POSTs /__ab/clear with the id", async () => {
    await renderApp();
    await tap("one");
    expect(webhookCalls()).toHaveLength(1);
    const { url, init } = webhookCalls()[0];
    expect(url).toBe(HOOK);
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>).Authorization).toBe(AUTH);
    const body = JSON.parse(String(init!.body));
    expect(Object.keys(body)).toEqual(["event", "decision_id", "question", "cleared_at"]);
    expect(body).toEqual({ event: "decision.not_relevant", decision_id: "one", question: "Secret question one?", cleared_at: body.cleared_at });
    expect(body.cleared_at).toMatch(ISO);
    expect(Math.abs(Date.parse(body.cleared_at) - Date.now())).toBeLessThan(5000);

    expect(clearCalls()).toHaveLength(1);
    const c = clearCalls()[0].init!;
    expect(c.method).toBe("POST");
    expect((c.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(String(c.body)).toBe(JSON.stringify({ id: "one" }));
    // Order: the webhook first, the clear after it.
    expect(calls.indexOf(webhookCalls()[0])).toBeLessThan(calls.indexOf(clearCalls()[0]));

    // Nothing is answered or stored; the card stays, Clearing... with the control disabled, until the board drops it.
    expect(shownIds()).toEqual(["one", "two", "bare"]);
    expect(window.localStorage.getItem(STORAGE_KEY) ?? "{}").toBe("{}");
    expect(window.localStorage.getItem(MESSAGES_KEY) ?? "{}").toBe("{}");
    const status = within(card("one")!).getByRole("status");
    expect(status.textContent).toBe("Clearing...");
    expect(status.className).toBe("not-relevant-status");
    expect(status.parentElement!.className).toBe("not-relevant");
    expect(button("one").disabled).toBe(true);
    expect(button("one").textContent).toBe(LABEL);
    expect(button("two").disabled).toBe(false);
    expect(within(card("two")!).queryByRole("status")).toBeNull();
    // A tap while clearing sends nothing more.
    await tap("one");
    expect([webhookCalls().length, clearCalls().length]).toEqual([1, 1]);
  });

  it("shows Clearing... while the webhook is in flight; a double tap sends one webhook POST and one clear", async () => {
    await renderApp();
    let release!: () => void;
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
    expect(within(card("one")!).getByRole("status").textContent).toBe("Clearing...");
    expect(clearCalls()).toHaveLength(0);
    release();
    await flush();
    await flush();
    expect(webhookCalls()).toHaveLength(1);
    expect(clearCalls()).toHaveLength(1);
  });

  it("removes the card once the live board drops it, and Needs you counts one fewer", async () => {
    const es = await renderApp();
    expect(needsYou()).toBe("3");
    await tap("two");
    expect(shownIds()).toEqual(["one", "two", "bare"]);
    // Another update that still has the card: it stays, still clearing.
    act(() => es.board({ ...initial, updated_at: "2026-11-10T10:00:00.000Z" }));
    expect(within(card("two")!).getByRole("status").textContent).toBe("Clearing...");
    act(() => es.board({ ...initial, updated_at: "2026-11-10T10:01:00.000Z", decisions: initial.decisions.filter((x) => x.id !== "two") }));
    expect(shownIds()).toEqual(["one", "bare"]);
    expect(card("two")).toBeNull();
    expect(needsYou()).toBe("2");
    // If the card ever comes back (ab restore), it starts fresh.
    act(() => es.board({ ...initial, updated_at: "2026-11-10T10:02:00.000Z" }));
    expect(button("two").disabled).toBe(false);
    expect(within(card("two")!).queryByRole("status")).toBeNull();
  });

  it("on a non-2xx webhook keeps the card, shows Could not send, re-enables the control and never clears", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    direct = 502;
    await renderApp();
    await tapAndWait("one");
    expect(webhookCalls()).toHaveLength(3);
    expect(clearCalls()).toHaveLength(0);
    const alert = within(card("one")!).getByRole("alert");
    expect(alert.textContent).toBe("Could not send. Try again.");
    expect(alert.className).toBe("not-relevant-error");
    expect(alert.parentElement!.className).toBe("not-relevant");
    expect(within(card("one")!).queryByRole("status")).toBeNull();
    expect(button("one").disabled).toBe(false);
    expect(shownIds()).toEqual(["one", "two", "bare"]);
    expect(needsYou()).toBe("3");

    // A later tap retries everything: the webhook again, then the clear.
    direct = 200;
    await act(async () => fireEvent.click(button("one")));
    expect(within(card("one")!).queryByRole("alert")).toBeNull();
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(webhookCalls()).toHaveLength(4);
    expect(clearCalls()).toHaveLength(1);
    expect(within(card("one")!).getByRole("status").textContent).toBe("Clearing...");
  });

  it("on a network error everywhere (direct throws, fallback fails) shows Could not send and never clears", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    direct = "cors";
    fallback = null;
    await renderApp();
    await tapAndWait("bare");
    expect(webhookCalls().map((c) => c.url)).toEqual([HOOK, FALLBACK_PATH, HOOK, FALLBACK_PATH, HOOK, FALLBACK_PATH]);
    expect(clearCalls()).toHaveLength(0);
    expect(within(card("bare")!).getByRole("alert").textContent).toBe("Could not send. Try again.");
    expect(button("bare").disabled).toBe(false);
    expect(shownIds()).toEqual(["one", "two", "bare"]);
  });

  it("webhook ok but the clear fails: says so, and the retry skips the webhook and only clears", async () => {
    clear = 502;
    await renderApp();
    await tap("one");
    expect([webhookCalls().length, clearCalls().length]).toEqual([1, 1]);
    const alert = within(card("one")!).getByRole("alert");
    expect(alert.textContent).toBe("Sent to your assistant, but could not clear. Try again.");
    expect(alert.className).toBe("not-relevant-error");
    expect(button("one").disabled).toBe(false);
    expect(shownIds()).toEqual(["one", "two", "bare"]);

    // Still failing (the route is down): the webhook is not sent again.
    clear = "down";
    await tap("one");
    expect([webhookCalls().length, clearCalls().length]).toEqual([1, 2]);
    expect(within(card("one")!).getByRole("alert").textContent).toBe("Sent to your assistant, but could not clear. Try again.");

    clear = 200;
    await tap("one");
    expect([webhookCalls().length, clearCalls().length]).toEqual([1, 3]);
    expect(within(card("one")!).queryByRole("alert")).toBeNull();
    expect(within(card("one")!).getByRole("status").textContent).toBe("Clearing...");
  });

  it("maps an unknown id from /__ab/clear (404) to the same clear failure", async () => {
    clear = 404;
    await renderApp();
    await tap("two");
    expect(within(card("two")!).getByRole("alert").textContent).toBe("Sent to your assistant, but could not clear. Try again.");
  });

  it("falls back to /__ab/webhook when the direct POST throws, then clears", async () => {
    direct = "cors";
    fallback = 201;
    await renderApp();
    await tap("one");
    expect(calls.filter((c) => c.url !== "/__ab/delivery-log" && c.url !== BOARD_PATH).map((c) => c.url)).toEqual([HOOK, FALLBACK_PATH, CLEAR_PATH]);
    const fb = webhookCalls()[1].init!;
    expect((fb.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(String(fb.body))).toMatchObject({ event: "decision.not_relevant", decision_id: "one", question: "Secret question one?" });
    expect(within(card("one")!).getByRole("status").textContent).toBe("Clearing...");
  });

  it("reports the attempt to the delivery log with the id only, never the question", async () => {
    await renderApp();
    await tap("one");
    expect(logCalls()).toHaveLength(1);
    const raw = String(logCalls()[0].init!.body);
    expect(raw).not.toContain("Secret question");
    expect(raw).not.toContain(HOOK);
    expect(raw).not.toContain("Bearer");
    expect(JSON.parse(raw)).toEqual({ event: "decision.not_relevant", decision_id: "one", http: 200, via: "direct", attempt: 1, status: "delivered", at: expect.stringMatching(ISO) });
  });

  it("is independent of Explain this better and the priority control", async () => {
    await renderApp();
    await act(async () => fireEvent.click(within(card("one")!).getByRole("button", { name: "Explain this better" })));
    await flush();
    expect(within(card("one")!).getByText("Rewording...")).toBeTruthy();
    expect(button("one").disabled).toBe(false);
    await tap("one");
    expect(within(card("one")!).getByText("Rewording...")).toBeTruthy();
    expect(within(card("one")!).getByText("Clearing...")).toBeTruthy();
    expect((within(card("one")!).getByRole("button", { name: "Explain this better" }) as HTMLButtonElement).disabled).toBe(true);
    expect(webhookCalls().map((c) => JSON.parse(String(c.init!.body)).event)).toEqual(["decision.clarify", "decision.not_relevant"]);
    // The priority segments stay usable while clearing.
    const low = within(card("one")!).getByRole("button", { name: "Low" }) as HTMLButtonElement;
    expect(low.disabled).toBe(false);
  });
});

describe("delivery.notRelevant", () => {
  const memory = (): KeyValueStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };
  const NOW = new Date("2026-11-10T12:34:56.789Z");

  it("builds the exact payload from the current question", () => {
    expect(JSON.stringify(buildNotRelevantPayload(d("x"), NOW))).toBe(
      '{"event":"decision.not_relevant","decision_id":"x","question":"Secret question x?","cleared_at":"2026-11-10T12:34:56.789Z"}',
    );
  });

  it("retries like clarify, reports each attempt without text, stores nothing, and resolves with the outcome", async () => {
    const storage = memory();
    const reports: DeliveryReport[] = [];
    const statuses = [500, 429, 204];
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
    expect(await delivery.notRelevant(buildNotRelevantPayload(d("x"), NOW))).toEqual({ ok: true, http: 204, via: "direct" });
    expect(slept).toEqual([500, 1500]);
    expect(reports.map((r) => [r.event, r.attempt, r.http, r.status])).toEqual([
      ["decision.not_relevant", 1, 500, "retrying"],
      ["decision.not_relevant", 2, 429, "retrying"],
      ["decision.not_relevant", 3, 204, "delivered"],
    ]);
    expect(Object.keys(reports[0])).toEqual(["event", "decision_id", "http", "via", "attempt", "status", "at"]);
    expect(JSON.stringify(reports)).not.toContain("Secret question");
    expect(storage.data.size).toBe(0);
  });

  it("resolves not ok with the last status after three failures", async () => {
    const delivery = createDelivery({
      fetch: vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
      sleep: async () => undefined,
      storage: memory(),
      webhookUrl: HOOK,
      fallbackUrl: FALLBACK_PATH,
      report: () => undefined,
    });
    expect(await delivery.notRelevant(buildNotRelevantPayload(d("x"), NOW))).toEqual({ ok: false, http: 503, via: "direct" });
  });
});
