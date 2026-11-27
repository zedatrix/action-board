// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Todo, Todos } from "../src/data/types";
import { TODO_PATH, TODOS_PATH } from "../src/useLiveTodos";

// Thu Nov 26 2026, 12:00 PM Eastern.
const NOW = new Date("2026-11-26T17:00:00.000Z");
const LATER = "2026-11-26T17:00:05.000Z";

const t = (id: string, name: string, extra: Partial<Todo> = {}): Todo => ({
  id,
  name,
  priority: "medium",
  comments: [],
  created_at: "2026-11-20T12:00:00.000Z",
  updated_at: "2026-11-20T12:00:00.000Z",
  ...extra,
});

const fixture: Todos = {
  updated_at: "2026-11-26T16:00:00.000Z",
  items: [
    t("a", "Pay rent", { due: { date: "2026-11-25" } }),
    t("b", "Call the vendor", {
      priority: "urgent",
      due: { date: "2026-11-26", time: "15:00" },
      comments: [{ id: "c1", text: "left a voicemail", author: "bot", at: "2026-11-26T14:00:00.000Z" }],
    }),
    t("c", "Send invoice", { priority: "high", due: { date: "2026-11-26", time: "09:00" } }),
    t("d", "Plan offsite", { priority: "low", due: { date: "2026-11-28" } }),
    t("e", "Read book"),
    t("f", "Book flights", { priority: "high", due: { date: "2026-11-27" } }),
    t("g", "Old thing", { due: { date: "2026-11-20" }, done_at: "2026-11-26T15:00:00.000Z" }),
    t("h", "Older thing", { done_at: "2026-11-24T15:00:00.000Z" }),
    t("s1", "Find number", { parent_id: "b", done_at: "2026-11-26T16:00:00.000Z" }),
    t("s2", "Prep notes", { parent_id: "b" }),
  ],
};

vi.mock("../src/data/todos", () => ({ todos: fixture }));

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
}

let posted: Record<string, unknown>[];
let status: number;

// The POST route as ab answers it: the to-do after the change.
function reply(body: Record<string, unknown>): Todo {
  const { action, id, ...rest } = body as { action: string; id?: string } & Record<string, unknown>;
  const old = fixture.items.find((x) => x.id === id);
  if (action === "add") return { ...t("new-1", rest.name as string), ...(rest as Partial<Todo>), created_at: LATER, updated_at: LATER };
  if (action === "done") return { ...old!, done_at: LATER, updated_at: LATER };
  if (action === "reopen") {
    const { done_at: _, ...open } = old!;
    return { ...open, updated_at: LATER };
  }
  if (action === "comment") return { ...old!, comments: [...old!.comments, { id: "c2", text: rest.text as string, author: "User", at: LATER }], updated_at: LATER };
  return { ...old!, ...(rest as Partial<Todo>), updated_at: LATER };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  posted = [];
  status = 200;
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== TODO_PATH) throw new Error("no network in tests");
      const body = JSON.parse(String(init!.body));
      posted.push(body);
      if (status !== 200) return new Response(JSON.stringify({ ok: false }), { status });
      return new Response(JSON.stringify({ ok: true, todo: reply(body) }), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderList() {
  const { TodoList } = await import("../src/TodoList");
  render(<TodoList now={NOW} />);
}

const names = () => [...document.querySelectorAll(".todo-list > .todo .todo-title")].map((e) => e.textContent);
const row = (name: string) => [...document.querySelectorAll<HTMLElement>(".todo")].find((r) => r.querySelector(".todo-title")?.textContent === name)!;
const view = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name} \\d+$`) });
const counts = () => ["Today", "Upcoming", "Done"].map((v) => view(v).textContent);
const flush = () => act(async () => {});

describe("Board to-do list", () => {
  it("opens on Today: due today and overdue, sorted by priority, urgent marked, overdue red with how late", async () => {
    await renderList();
    expect(counts()).toEqual(["Today 3", "Upcoming 3", "Done 3"]);
    expect(view("Today").getAttribute("aria-pressed")).toBe("true");
    expect(names()).toEqual(["Call the vendor", "Send invoice", "Pay rent"]);

    expect(row("Call the vendor").dataset.priority).toBe("urgent");
    expect(row("Call the vendor").querySelector(".todo-urgent")).not.toBeNull();
    expect(row("Send invoice").querySelector(".todo-urgent")).toBeNull();

    expect(row("Call the vendor").dataset.overdue).toBeUndefined();
    expect(row("Call the vendor").querySelector(".todo-due")!.textContent).toBe("Today 3:00 PM");
    expect(row("Send invoice").dataset.overdue).toBe("true");
    expect(row("Send invoice").querySelector(".todo-due.overdue")!.textContent).toBe("Today 9:00 AM · 3 h late");
    expect(row("Pay rent").querySelector(".todo-due.overdue")!.textContent).toBe("Yesterday · 1 day late");
  });

  it("shows priority, subtask progress and comment count chips on each row", async () => {
    await renderList();
    const r = within(row("Call the vendor"));
    expect(r.getByRole("button", { name: "Priority urgent, tap for high" }).textContent).toBe("urgent");
    expect(r.getByLabelText("1 of 2 subtasks done").textContent).toBe("1/2");
    expect(r.getByLabelText("1 comment").textContent).toBe("1");
    expect(row("Pay rent").querySelector(".todo-subs, .todo-comments")).toBeNull();
  });

  it("switches views: Upcoming groups by day with No date last; Done is newest completion first with the time in Eastern", async () => {
    await renderList();
    fireEvent.click(view("Upcoming"));
    expect(view("Upcoming").getAttribute("aria-pressed")).toBe("true");
    expect(view("Today").getAttribute("aria-pressed")).toBe("false");
    const groups = [...document.querySelectorAll<HTMLElement>(".todo-day")];
    expect(groups.map((g) => g.querySelector("h3")!.textContent)).toEqual(["Tomorrow", "Sat, Nov 28", "No date"]);
    expect(groups.map((g) => [...g.querySelectorAll(".todo-title")].map((e) => e.textContent))).toEqual([["Book flights"], ["Plan offsite"], ["Read book"]]);

    fireEvent.click(view("Done"));
    expect(names()).toEqual(["Find number", "Old thing", "Older thing"]);
    expect(row("Old thing").querySelector(".todo-done-at")!.textContent).toBe("Done Nov 26, 2026, 10:00 AM ET");
    expect((within(row("Old thing")).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    // An overdue due date is not red outside Today.
    expect(document.querySelector(".overdue")).toBeNull();
  });

  it("quick add posts the parsed to-do and clears the field; the new one shows in Upcoming", async () => {
    await renderList();
    const input = screen.getByRole("textbox", { name: "Add a to-do" });
    fireEvent.change(input, { target: { value: "call the vendor Friday 3pm p1" } });
    await act(async () => fireEvent.submit(input.closest("form")!));
    expect(posted).toEqual([{ action: "add", name: "call the vendor", priority: "urgent", due: { date: "2026-11-27", time: "15:00" } }]);
    expect((input as HTMLInputElement).value).toBe("");
    expect(document.getElementById("todo-add-note")!.textContent).toBe('Added "call the vendor", due Tomorrow 3:00 PM.');
    expect(counts()).toEqual(["Today 3", "Upcoming 4", "Done 3"]);
    fireEvent.click(view("Upcoming"));
    expect(row("call the vendor").dataset.priority).toBe("urgent");
  });

  it("quick add refuses a name that is only a date and priority, and posts nothing", async () => {
    await renderList();
    const input = screen.getByRole("textbox", { name: "Add a to-do" });
    fireEvent.change(input, { target: { value: "Friday 3pm p1" } });
    await act(async () => fireEvent.submit(input.closest("form")!));
    expect(posted).toEqual([]);
    expect((input as HTMLInputElement).value).toBe("Friday 3pm p1");
    expect(document.getElementById("todo-add-note")!.textContent).toBe("Add a name besides the date and priority.");
  });

  it("completes a to-do with its checkbox: it leaves Today and shows in Done", async () => {
    await renderList();
    await act(async () => fireEvent.click(within(row("Send invoice")).getByRole("checkbox", { name: "Complete Send invoice" })));
    expect(posted).toEqual([{ action: "done", id: "c" }]);
    expect(names()).toEqual(["Call the vendor", "Pay rent"]);
    expect(counts()).toEqual(["Today 2", "Upcoming 3", "Done 4"]);
    fireEvent.click(view("Done"));
    expect(names()[0]).toBe("Send invoice");
  });

  it("reopens from Done", async () => {
    await renderList();
    fireEvent.click(view("Done"));
    await act(async () => fireEvent.click(within(row("Old thing")).getByRole("button", { name: "Reopen" })));
    expect(posted).toEqual([{ action: "reopen", id: "g" }]);
    expect(names()).toEqual(["Find number", "Older thing"]);
    fireEvent.click(view("Today"));
    expect(names()).toContain("Old thing");
  });

  it("cycles priority from the chip", async () => {
    await renderList();
    await act(async () => fireEvent.click(within(row("Pay rent")).getByRole("button", { name: "Priority medium, tap for low" })));
    expect(posted).toEqual([{ action: "update", id: "a", priority: "low" }]);
    expect(row("Pay rent").dataset.priority).toBe("low");
  });

  it("expands a row to its details and comments thread, and adds a comment", async () => {
    await renderList();
    const name = within(row("Call the vendor")).getByRole("button", { name: /Call the vendor/ });
    fireEvent.click(name);
    expect(name.getAttribute("aria-expanded")).toBe("true");
    const r = within(row("Call the vendor"));
    expect((r.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Call the vendor");
    expect(r.getByRole("group", { name: "Priority" })).toBeTruthy();
    expect(r.getByRole("button", { name: "urgent", pressed: true })).toBeTruthy();
    expect((r.getByLabelText("Due date (ET)") as HTMLInputElement).value).toBe("2026-11-26");
    expect((r.getByLabelText("Time") as HTMLInputElement).value).toBe("15:00");
    expect([...row("Call the vendor").querySelectorAll(".todo-subtask span")].map((e) => e.textContent)).toEqual(["Prep notes", "Find number"]);
    expect(row("Call the vendor").querySelector(".todo-comment")!.textContent).toContain("left a voicemail");
    expect(row("Call the vendor").querySelector(".todo-comment-meta")!.textContent).toMatch(/^bot · Nov 26, 2026, 9:00 AM ET$/);

    fireEvent.change(r.getByRole("textbox", { name: "Add a comment" }), { target: { value: "  call back at 4  " } });
    await act(async () => fireEvent.click(r.getByRole("button", { name: "Comment" })));
    expect(posted).toEqual([{ action: "comment", id: "b", text: "call back at 4" }]);
    const thread = [...row("Call the vendor").querySelectorAll(".todo-comment p")].map((e) => e.textContent);
    expect(thread).toEqual(["left a voicemail", "call back at 4"]);
    expect(within(row("Call the vendor")).getByLabelText("2 comments")).toBeTruthy();
    expect((r.getByRole("textbox", { name: "Add a comment" }) as HTMLInputElement).value).toBe("");

    fireEvent.click(name);
    expect(row("Call the vendor").querySelector(".todo-details")).toBeNull();
  });

  it("adds a subtask under the expanded to-do and saves an edited name on blur", async () => {
    await renderList();
    fireEvent.click(within(row("Call the vendor")).getByRole("button", { name: /Call the vendor/ }));
    const r = within(row("Call the vendor"));
    fireEvent.change(r.getByRole("textbox", { name: "Add a subtask" }), { target: { value: "Dial in" } });
    await act(async () => fireEvent.submit(r.getByRole("textbox", { name: "Add a subtask" }).closest("form")!));
    const nameField = r.getByRole("textbox", { name: "Name" });
    fireEvent.change(nameField, { target: { value: "Call the vendor back " } });
    await act(async () => fireEvent.blur(nameField));
    expect(posted).toEqual([
      { action: "add", name: "Dial in", parent_id: "b" },
      { action: "update", id: "b", name: "Call the vendor back" },
    ]);
  });

  it("shows an error when the server refuses a change", async () => {
    status = 502;
    await renderList();
    await act(async () => fireEvent.click(within(row("Pay rent")).getByRole("checkbox")));
    expect(screen.getByRole("alert").textContent).toBe("Could not save. Try again.");
    expect(names()).toEqual(["Call the vendor", "Send invoice", "Pay rent"]);
  });

  it("follows live todos events on the shared stream", async () => {
    await renderList();
    const es = FakeEventSource.instances.at(-1)!;
    const next: Todos = { updated_at: LATER, items: [t("z", "Brand new", { due: { date: "2026-11-26" } })] };
    act(() => void es.dispatchEvent(new MessageEvent("todos", { data: JSON.stringify(next) })));
    expect(names()).toEqual(["Brand new"]);
    expect(counts()).toEqual(["Today 1", "Upcoming 0", "Done 0"]);
    act(() => void es.dispatchEvent(new MessageEvent("todos", { data: '{"items":"nope"}' })));
    expect(names()).toEqual(["Brand new"]);
    await flush();
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === TODOS_PATH)).toHaveLength(0);
  });
});
