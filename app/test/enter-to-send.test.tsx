// @vitest-environment jsdom
// Keyboard sending for the two free-text boxes: the Message your assistant composer (textarea) and a decision card's own-answer
// field (single-line input). Plain Enter must take the same path as the button: one POST, same payload shape.
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";
import { STORAGE_KEY } from "../src/delivery";
import { withPrs } from "./board-with-prs";

const HOOK = "http://hook.test/assistant";

const decision = (id: string, extra: object = {}) => ({
  id,
  card_ref: "PROJ-1",
  question: "Same question?",
  what_happens_after: "Something happens.",
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  created_at: "2026-11-10T09:00:00.000Z",
  ...extra,
});

vi.mock("../src/data/board", () => ({
  board: {
    updated_at: "2026-11-10T09:00:00.000Z",
    decisions: [decision("s1"), decision("s2"), decision("m1", { multiSelect: true }), decision("m2", { multiSelect: true })],
    glance: {
      waiting: [
        { title: "Item A", who: "QA" },
        { title: "Item B", who: "QA" },
      ],
      tickets: [],
    },
  } satisfies Board,
}));

let posted: Record<string, unknown>[];

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  posted = [];
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", HOOK);
  vi.stubEnv("ACTION_BOARD_WEBHOOK_AUTH", "Bearer test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === HOOK) {
        posted.push(JSON.parse(String(init.body)));
        return new Response("ok", { status: 200 });
      }
      if (url === "/__ab/delivery-log") return new Response(null, { status: 204 });
      throw new Error("no network in tests");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// The Board and the PRs tab, where the glance items now are.
async function renderApp() {
  const { default: App } = await import("../src/App");
  const BoardAndPrs = withPrs(App);
  render(<BoardAndPrs />);
}

// fireEvent returns false when a handler called preventDefault, i.e. the browser would not insert a newline.
const key = (el: HTMLElement, init: KeyboardEventInit & { keyCode?: number } = {}) => {
  let notPrevented = true;
  act(() => void (notPrevented = fireEvent.keyDown(el, { key: "Enter", code: "Enter", ...init })));
  return notPrevented;
};
const flush = () => act(async () => {});
// Drops the fields that differ between two sends of the same thing.
const shape = (p: Record<string, unknown>, ...drop: string[]) => Object.fromEntries(Object.entries(p).filter(([k]) => !drop.includes(k)));

describe("Message your assistant composer: keyboard", () => {
  const item = (title: string) => [...document.querySelectorAll<HTMLElement>("[data-item-section=waiting]")].find((e) => e.textContent!.includes(title))!;
  const open = (title: string) => {
    const w = within(item(title));
    fireEvent.click(w.getByRole("button", { name: /^Message your assistant about/ }));
    return { field: w.getByRole("textbox") as HTMLTextAreaElement, w };
  };

  it("shows the keyboard hint, tied to the field", async () => {
    await renderApp();
    const { field } = open("Item A");
    const hint = document.getElementById(field.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe("Enter to send, Shift+Enter for a new line");
    expect(hint.className).toBe("hint");
  });

  it("Enter sends once, with the same payload shape as the Send button", async () => {
    await renderApp();
    const a = open("Item A");
    fireEvent.change(a.field, { target: { value: "  same note  " } });
    await act(async () => fireEvent.click(a.w.getByRole("button", { name: "Send" })));
    await flush();
    expect(posted).toHaveLength(1);

    const b = open("Item B");
    fireEvent.change(b.field, { target: { value: "  same note  " } });
    expect(key(b.field)).toBe(false);
    // A second Enter after the first sends nothing more.
    key(b.field);
    await flush();
    expect(posted).toHaveLength(2);

    const [viaButton, viaEnter] = posted;
    expect(Object.keys(viaEnter)).toEqual(Object.keys(viaButton));
    expect(viaEnter.text).toBe("same note");
    expect(viaEnter.message_id).not.toBe(viaButton.message_id);
    expect(shape(viaEnter, "message_id", "sent_at", "item_id", "item_title")).toEqual(shape(viaButton, "message_id", "sent_at", "item_id", "item_title"));
    expect(viaEnter.item_title).toBe("Item B");
  });

  it("Enter twice in a row before delivery delivers once (the composer locks on the first)", async () => {
    await renderApp();
    const { field } = open("Item A");
    fireEvent.change(field, { target: { value: "once" } });
    key(field);
    expect(field.readOnly).toBe(true);
    key(field);
    await flush();
    expect(posted).toHaveLength(1);
  });

  it("Shift+Enter and Alt+Enter leave the newline to the browser and do not send", async () => {
    await renderApp();
    const { field } = open("Item A");
    fireEvent.change(field, { target: { value: "line one" } });
    expect(key(field, { shiftKey: true })).toBe(true);
    expect(key(field, { altKey: true })).toBe(true);
    await flush();
    expect(posted).toHaveLength(0);
    expect(field.value).toBe("line one");
  });

  it("Cmd+Enter and Ctrl+Enter insert a newline at the caret and do not send", async () => {
    await renderApp();
    const { field } = open("Item A");
    fireEvent.change(field, { target: { value: "ab" } });
    field.setSelectionRange(1, 1);
    expect(key(field, { metaKey: true })).toBe(false);
    expect(field.value).toBe("a\nb");
    expect(field.selectionStart).toBe(2);
    expect(key(field, { ctrlKey: true })).toBe(false);
    expect(field.value).toBe("a\n\nb");
    expect(field.selectionStart).toBe(3);
    // A selection is replaced, like typing.
    field.setSelectionRange(0, 4);
    key(field, { metaKey: true });
    expect(field.value).toBe("\n");
    await flush();
    expect(posted).toHaveLength(0);
    // State stayed in sync: plain Enter then sends the text as shown, which trims to blank, so nothing goes.
    key(field);
    await flush();
    expect(posted).toHaveLength(0);
  });

  it("does not send while an IME is composing", async () => {
    await renderApp();
    const { field } = open("Item A");
    fireEvent.change(field, { target: { value: "にほん" } });
    expect(key(field, { isComposing: true })).toBe(true);
    expect(key(field, { keyCode: 229 })).toBe(true);
    await flush();
    expect(posted).toHaveLength(0);
    expect(field.value).toBe("にほん");
  });

  it("Enter on empty or whitespace-only text does nothing, not even a newline", async () => {
    await renderApp();
    const { field } = open("Item A");
    expect(key(field)).toBe(false);
    fireEvent.change(field, { target: { value: "  \n\t " } });
    expect(key(field)).toBe(false);
    await flush();
    expect(posted).toHaveLength(0);
    expect(field.value).toBe("  \n\t ");
    expect(field.readOnly).toBe(false);
  });
});

describe("Decision card own answer: keyboard", () => {
  const card = (id: string) => within(document.querySelector<HTMLElement>(`[data-decision-id="${id}"]`)!);
  const input = (id: string) => card(id).getByRole("textbox", { name: "Your own answer" }) as HTMLInputElement;

  it("Enter sends once, with the same payload as Send answer", async () => {
    await renderApp();
    fireEvent.change(input("s1"), { target: { value: "  Ask Sage  " } });
    await act(async () => fireEvent.click(card("s1").getByRole("button", { name: "Send answer" })));
    fireEvent.change(input("s2"), { target: { value: "  Ask Sage  " } });
    const field = input("s2");
    expect(key(field)).toBe(false);
    // The card is gone after the first Enter; a repeat on the detached field sends nothing more.
    key(field);
    await flush();

    expect(posted).toHaveLength(2);
    const [viaButton, viaEnter] = posted;
    expect(Object.keys(viaEnter)).toEqual(Object.keys(viaButton));
    expect(viaEnter).toMatchObject({ decision_id: "s2", answer: "custom", answer_label: "Ask Sage", custom_text: "Ask Sage" });
    expect(shape(viaEnter, "decision_id", "answered_at")).toEqual(shape(viaButton, "decision_id", "answered_at"));
  });

  it("on a multi-select card, Enter sends the custom text exactly as Send answer does, ignoring picked options", async () => {
    await renderApp();
    for (const id of ["m1", "m2"]) {
      fireEvent.click(card(id).getByRole("button", { name: "Yes" }));
      fireEvent.change(input(id), { target: { value: "Both later" } });
    }
    await act(async () => fireEvent.click(card("m1").getByRole("button", { name: "Send answer" })));
    key(input("m2"));
    await flush();

    expect(posted).toHaveLength(2);
    const [viaButton, viaEnter] = posted;
    expect(viaEnter).toMatchObject({ decision_id: "m2", answer: "custom", custom_text: "Both later" });
    expect(shape(viaEnter, "decision_id", "answered_at")).toEqual(shape(viaButton, "decision_id", "answered_at"));
  });

  it("Enter with Shift, Cmd, Ctrl or Alt does nothing in the single-line field", async () => {
    await renderApp();
    const field = input("s1");
    fireEvent.change(field, { target: { value: "Ask Sage" } });
    for (const mod of ["shiftKey", "metaKey", "ctrlKey", "altKey"]) expect(key(field, { [mod]: true })).toBe(false);
    await flush();
    expect(posted).toHaveLength(0);
    expect(field.value).toBe("Ask Sage");
    expect(document.querySelector('[data-decision-id="s1"]')).not.toBeNull();
  });

  it("does not send while an IME is composing", async () => {
    await renderApp();
    const field = input("s1");
    fireEvent.change(field, { target: { value: "にほん" } });
    key(field, { isComposing: true });
    key(field, { keyCode: 229 });
    await flush();
    expect(posted).toHaveLength(0);
    expect(document.querySelector('[data-decision-id="s1"]')).not.toBeNull();
  });

  it("Enter on empty or whitespace-only text does nothing", async () => {
    await renderApp();
    const field = input("s1");
    key(field);
    fireEvent.change(field, { target: { value: "   \t " } });
    key(field);
    await flush();
    expect(posted).toHaveLength(0);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(document.querySelector('[data-decision-id="s1"]')).not.toBeNull();
  });
});
