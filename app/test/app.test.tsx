// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";
import { STORAGE_KEY } from "../src/delivery";

const at = { answered_by: "chat" as const, answered_at: "2026-11-10T10:00:00.000Z" };
const opts = [
  { id: "yes", label: "Yes" },
  { id: "no", label: "No" },
];
const d = (id: string, extra: object = {}) => ({
  id,
  card_ref: null,
  question: `Question ${id}?`,
  what_happens_after: "Something happens.",
  options: opts,
  created_at: "2026-11-10T09:00:00.000Z",
  ...extra,
});

// The real board.ts has no decisions; swap in one that covers every shape.
vi.mock("../src/data/board", () => ({
  board: {
    updated_at: "2026-11-10T09:00:00.000Z",
    decisions: [
      d("single"),
      d("multi", { multiSelect: true }),
      d("closed", { allowCustom: false }),
      d("file-single", { answer: { answer: "yes", answer_label: "Yes", ...at } }),
      d("file-multi", { multiSelect: true, answer: { answer: ["yes", "no"], answer_label: ["Yes", "No"], ...at } }),
      d("file-custom", { answer: { answer: "custom", answer_label: "Later", custom_text: "Later", ...at } }),
    ],
    glance: { waiting: [], tickets: [] },
  } satisfies Board,
}));

beforeEach(() => {
  window.localStorage.clear();
  // No webhook in tests: answers stay pending and nothing is posted.
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", "");
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in tests"))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const stored = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
const card = (id: string) => document.querySelector<HTMLElement>(`[data-decision-id="${id}"]`);
const shownIds = () => [...document.querySelectorAll("[data-decision-id]")].map((e) => e.getAttribute("data-decision-id"));

async function renderApp() {
  const { default: App } = await import("../src/App");
  render(<App />);
}

describe("App", () => {
  it("hides decisions the file answered in each shape, and shows the B4 sections", async () => {
    await renderApp();
    expect(shownIds()).toEqual(["single", "multi", "closed"]);
    expect(screen.getByRole("heading", { name: /Needs you\s*3/ })).toBeTruthy();
    for (const name of ["Waiting on others", "Tickets with no PR yet"]) expect(screen.getByRole("heading", { name: new RegExp(name) })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Parked/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/parked/i);
    expect(within(card("closed")!).queryByRole("textbox")).toBeNull();
    expect(within(card("single")!).getByRole("textbox")).toBeTruthy();
  });

  it("records a multi answer in option order, hides the card and toasts the labels", async () => {
    await renderApp();
    const c = within(card("multi")!);
    fireEvent.click(c.getByRole("button", { name: "No" }));
    fireEvent.click(c.getByRole("button", { name: "Yes" }));
    await act(async () => fireEvent.click(c.getByRole("button", { name: "Submit" })));
    expect(stored().multi.payload).toMatchObject({ answer: ["yes", "no"], answer_label: ["Yes", "No"], answered_by: "app" });
    expect(stored().multi.status).toBe("pending");
    expect(card("multi")).toBeNull();
    expect(screen.getByText("Answered: Yes, No")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Webhook not set up (app/.env.local)");
  });

  it("records nothing for blank text and records trimmed custom text", async () => {
    await renderApp();
    const c = within(card("single")!);
    const input = c.getByRole("textbox");
    fireEvent.change(input, { target: { value: "    " } });
    fireEvent.submit(input.closest("form")!);
    expect(stored()).toEqual({});
    expect(card("single")).not.toBeNull();

    fireEvent.change(input, { target: { value: "  Neither, ask Sage  " } });
    await act(async () => fireEvent.click(c.getByRole("button", { name: "Send answer" })));
    expect(stored().single.payload).toMatchObject({ answer: "custom", answer_label: "Neither, ask Sage", custom_text: "Neither, ask Sage" });
    expect(card("single")).toBeNull();
  });
});
