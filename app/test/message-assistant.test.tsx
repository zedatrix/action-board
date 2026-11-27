// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";
import { MESSAGES_KEY, STORAGE_KEY } from "../src/delivery";
import { withPrs } from "./board-with-prs";

const HOOK = "http://hook.test/assistant";
const PR = "https://github.com/acme/example-web/pull/11461";

const decision = (id: string) => ({
  id,
  card_ref: null,
  question: `Question ${id}?`,
  what_happens_after: "Something happens.",
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  created_at: "2026-11-10T09:00:00.000Z",
});

vi.mock("../src/data/board", () => ({
  board: {
    updated_at: "2026-11-10T09:00:00.000Z",
    decisions: [decision("one"), decision("two")],
    glance: {
      waiting: [
        { title: "Error, not success, on failed checkout actions (#11461)", who: "Riley's rescoring", link: PR },
        { title: "QA pass on the banner", who: "QA" },
      ],
      // The first ticket has no id and the same link as the first waiting item: same item_id, different section.
      tickets: [
        { id: "", title: "Out-of-scope extras on the banner", status: "To Do", link: PR },
        { id: "PROJ-15067", title: "Align weeks to the Friday cutoff", status: "In Progress", link: "https://example.com/tickets/PROJ-15067" },
      ],
    },
  } satisfies Board,
}));

let statuses: number[];
let posted: { url: string; init: RequestInit }[];

function stubFetch() {
  posted = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === HOOK) {
        posted.push({ url, init });
        return new Response("ok", { status: statuses.length > 1 ? statuses.shift()! : statuses[0] });
      }
      if (url === "/__ab/delivery-log") return new Response(null, { status: 204 });
      throw new Error("no network in tests");
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  statuses = [200];
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", HOOK);
  vi.stubEnv("ACTION_BOARD_WEBHOOK_AUTH", "Bearer test-auth  value");
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const root = (id: string, section: string) =>
  [...document.querySelectorAll<HTMLElement>(`[data-item-section="${section}"]`)].find((e) => e.dataset.itemId === id)!;
const messages = () => JSON.parse(window.localStorage.getItem(MESSAGES_KEY) ?? "{}");
const shownDecisions = () => [...document.querySelectorAll("[data-decision-id]")].map((e) => e.getAttribute("data-decision-id"));

// The Board and the PRs tab, where the glance items now are.
async function renderApp() {
  const { default: App } = await import("../src/App");
  const BoardAndPrs = withPrs(App);
  return render(<BoardAndPrs />);
}

async function send(el: HTMLElement, text: string) {
  const w = within(el);
  fireEvent.click(w.getByRole("button", { name: /^Message your assistant about/ }));
  fireEvent.change(w.getByRole("textbox", { name: /^Message to your assistant about/ }), { target: { value: text } });
  await act(async () => fireEvent.click(w.getByRole("button", { name: "Send" })));
}

describe("Message your assistant", () => {
  it("puts a Message your assistant button on every glance item, each with a stable data-item-id, and none on decision cards", async () => {
    await renderApp();
    const roots = [...document.querySelectorAll<HTMLElement>("[data-item-id]")];
    expect(roots.map((r) => [r.dataset.itemSection, r.dataset.itemId])).toEqual([
      ["waiting", PR],
      ["waiting", "waiting:qa-pass-on-the-banner"],
      ["tickets", PR],
      ["tickets", "PROJ-15067"],
    ]);
    for (const r of roots) {
      const btn = within(r).getByRole("button", { name: /^Message your assistant about/ });
      expect(btn.textContent).toBe("Message your assistant");
      expect(btn.className).toBe("msg-btn");
      expect(btn.getAttribute("aria-expanded")).toBe("false");
    }
    const cards = [...document.querySelectorAll<HTMLElement>("[data-decision-id]")];
    expect(cards).toHaveLength(2);
    for (const c of cards) {
      expect(within(c).queryByRole("button", { name: /Message your assistant/ })).toBeNull();
      expect(c.querySelector(".msg-btn, .msg-status, .composer")).toBeNull();
    }
    expect(within(cards[0].querySelector<HTMLElement>(".options")!).getAllByRole("button")[0].textContent).toBe("Yes");
  });

  it("opens a composer on one item only; blank text cannot be sent; Cancel closes it", async () => {
    await renderApp();
    const waiting = root(PR, "waiting");
    fireEvent.click(within(waiting).getByRole("button", { name: /^Message your assistant/ }));
    expect(document.querySelectorAll("textarea")).toHaveLength(1);
    // Same item_id in Open tickets, but its composer stays closed.
    expect(within(root(PR, "tickets")).queryByRole("textbox")).toBeNull();

    const sendBtn = within(waiting).getByRole("button", { name: "Send" }) as HTMLButtonElement;
    const field = within(waiting).getByRole("textbox");
    expect(sendBtn.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "  \n\t " } });
    expect(sendBtn.disabled).toBe(true);
    await act(async () => fireEvent.submit(field.closest("form")!));
    await act(async () => fireEvent.keyDown(field, { key: "Enter", metaKey: true }));
    expect(messages()).toEqual({});
    expect(posted).toHaveLength(0);

    fireEvent.click(within(waiting).getByRole("button", { name: "Cancel" }));
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("sends the exact payload, closes on 200, shows Sent to your assistant, leaves the item as it was, and keeps it across a reload", async () => {
    const view = await renderApp();
    const waiting = root(PR, "waiting");
    const before = waiting.querySelector("a.item")!.outerHTML;
    await send(waiting, "  Ping Riley about the rescoring  ");

    expect(posted).toHaveLength(1);
    expect(posted[0].init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer test-auth  value" });
    const body = JSON.parse(String(posted[0].init.body));
    expect(Object.keys(body)).toEqual(["event", "message_id", "item_id", "item_section", "item_title", "item_who", "item_link", "text", "sent_at"]);
    expect(body).toMatchObject({
      event: "item.message",
      item_id: PR,
      item_section: "waiting",
      item_title: "Error, not success, on failed checkout actions (#11461)",
      item_who: "Riley's rescoring",
      item_link: PR,
      text: "Ping Riley about the rescoring",
    });
    expect(body.message_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.sent_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

    expect(within(waiting).queryByRole("textbox")).toBeNull();
    expect(waiting.querySelector(".msg-status")!.textContent).toMatch(/^Sent to your assistant · \S/);
    expect(waiting.querySelector("a.item")!.outerHTML).toBe(before);
    // The ticket with the same link shows nothing.
    expect(root(PR, "tickets").querySelector(".msg-status")).toBeNull();
    expect(messages()[body.message_id]).toMatchObject({ status: "delivered", attempts: 1, last_http: 200 });

    view.unmount();
    await renderApp();
    expect(root(PR, "waiting").querySelector(".msg-status")!.textContent).toMatch(/^Sent to your assistant · /);
    expect(posted).toHaveLength(1);
  });

  it("a message on a glance item leaves Needs you as it was and records no answer", async () => {
    await renderApp();
    await send(root("PROJ-15067", "tickets"), "Is this on for Friday?");
    expect(shownDecisions()).toEqual(["one", "two"]);
    expect(screen.getByRole("heading", { name: /Needs you\s*2/ })).toBeTruthy();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(posted).toHaveLength(1);
  });

  it("shows Sending..., then Not delivered, will retry after a failed cycle, and delivers on focus", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    statuses = [500, 500, 500, 200];
    await renderApp();
    const ticket = root("PROJ-15067", "tickets");
    await send(ticket, "Is this on for Friday?");
    expect(ticket.querySelector(".msg-status")!.textContent).toBe("Not sent yet, retrying");
    expect(within(ticket).getByRole("textbox")).toBeTruthy();
    expect((within(ticket).getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => void (await vi.advanceTimersByTimeAsync(2500)));
    expect(posted).toHaveLength(3);
    expect(ticket.querySelector(".msg-status")!.textContent).toBe("Not delivered, will retry");
    expect(Object.values(messages())[0]).toMatchObject({ status: "failed", attempts: 3, last_http: 500 });

    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(posted).toHaveLength(4);
    expect(ticket.querySelector(".msg-status")!.textContent).toMatch(/^Sent to your assistant/);
    expect(within(ticket).queryByRole("textbox")).toBeNull();
    expect(JSON.parse(String(posted[3].init.body))).toMatchObject({ item_id: "PROJ-15067", item_status: "In Progress" });
  });

  it("flushes a failed message stored by an earlier page load", async () => {
    statuses = [200];
    const payload = {
      event: "item.message",
      message_id: "m-old",
      item_id: "gone-item",
      item_section: "waiting",
      item_title: "No longer on the board",
      text: "Still want this",
      sent_at: "2026-11-10T08:00:00.000Z",
    };
    window.localStorage.setItem(MESSAGES_KEY, JSON.stringify({ "m-old": { payload, status: "failed", attempts: 3, last_http: 500, last_at: null } }));
    await act(async () => void (await renderApp()));
    expect(posted.map((p) => p.init.body)).toEqual([JSON.stringify(payload)]);
    expect(messages()["m-old"]).toMatchObject({ status: "delivered", attempts: 4, last_http: 200 });
  });

  it("without a webhook URL: Not sent yet, retrying, the header marker, and nothing posted", async () => {
    vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", "");
    await renderApp();
    const item = root("waiting:qa-pass-on-the-banner", "waiting");
    await send(item, "Who is on QA?");
    expect(posted).toHaveLength(0);
    expect(item.querySelector(".msg-status")!.textContent).toBe("Not sent yet, retrying");
    expect(screen.getByRole("status").textContent).toBe("Webhook not set up (app/.env.local)");
    expect(Object.values(messages())[0]).toMatchObject({ status: "pending", attempts: 0 });
  });
});

describe("messageStatusText", () => {
  it("maps each delivery state to its line", async () => {
    const { messageStatusText } = await import("../src/MessageAssistant");
    const payload = {
      event: "item.message" as const,
      message_id: "m",
      item_id: "i",
      item_section: "waiting" as const,
      item_title: "t",
      text: "x",
      sent_at: new Date().toISOString(),
    };
    const rec = (status: "pending" | "failed" | "delivered", attempts: number) => ({ payload, status, attempts, last_http: null, last_at: null });
    expect(messageStatusText(rec("pending", 0), true)).toBe("Sending...");
    expect(messageStatusText(rec("pending", 1), true)).toBe("Not sent yet, retrying");
    expect(messageStatusText(rec("pending", 0), false)).toBe("Not sent yet, retrying");
    expect(messageStatusText(rec("failed", 3), true)).toBe("Not delivered, will retry");
    const at = new Date(2026, 10, 10, 14, 5);
    const sent = messageStatusText({ ...rec("delivered", 1), last_at: at.toISOString() }, true);
    expect(sent.startsWith("Sent to your assistant · ")).toBe(true);
    expect(sent).toContain(at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  });
});
