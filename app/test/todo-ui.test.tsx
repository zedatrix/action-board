// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Todo, Todos } from "../src/data/types";
import { DELIVERY_LOG_PATH, loadMessages } from "../src/delivery";
import { TODO_PATH, TODOS_PATH } from "../src/useLiveTodos";

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
    t("f", "Book flights", { priority: "high", due: { date: "2026-11-27" }, parent_id: "g", created_at: "2026-11-19T12:00:00.000Z" }),
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
  window.localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function renderList() {
  const { TodoList } = await import("../src/TodoList");
  render(<TodoList />);
}

const names = (list = "Open to-dos") => [...screen.getByRole("list", { name: list }).querySelectorAll(".todo-title")].map((e) => e.textContent);
const row = (name: string) => [...document.querySelectorAll<HTMLElement>(".todo")].find((r) => r.querySelector(".todo-title")?.textContent === name)!;
const doneToggle = () => screen.getByRole("button", { name: /^Done \(\d+\)$/ });
const flush = () => act(async () => {});

describe("Board to-do list", () => {
  it("shows one open list sorted by priority, then creation time, with Done collapsed", async () => {
    await renderList();
    expect(names()).toEqual(["Call the vendor", "Book flights", "Send invoice", "Pay rent", "Read book", "Prep notes", "Plan offsite"]);
    expect(screen.getAllByRole("list")).toHaveLength(1);
    expect(doneToggle().textContent).toBe("Done (3)");
    expect(doneToggle().getAttribute("aria-expanded")).toBe("false");
    expect(row("Call the vendor").querySelector(".todo-urgent")).not.toBeNull();
    expect(row("Send invoice").querySelector(".todo-urgent")).toBeNull();

    fireEvent.click(doneToggle());
    expect(doneToggle().getAttribute("aria-expanded")).toBe("true");
    expect(names("Done to-dos")).toEqual(["Find number", "Old thing", "Older thing"]);
    fireEvent.click(doneToggle());
    expect(screen.queryByRole("list", { name: "Done to-dos" })).toBeNull();
  });

  it("shows priority, subtask progress and comment count chips on each row", async () => {
    await renderList();
    const r = within(row("Call the vendor"));
    expect(r.getByRole("button", { name: "Priority urgent, tap for high" }).textContent).toBe("urgent");
    expect(r.getByLabelText("1 of 2 subtasks done").textContent).toBe("1/2");
    expect(r.getByLabelText("1 comment").textContent).toBe("1");
    expect(row("Pay rent").querySelector(".todo-subs, .todo-comments")).toBeNull();
  });

  it("opens the shared composer on a to-do row, enqueues its message, and retries delivery", async () => {
    const hook = "https://example.com/assistant";
    vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", hook);
    vi.stubEnv("ACTION_BOARD_ASSISTANT_NAME", "");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const bodies: string[] = [];
    const reports: unknown[] = [];
    let webhookStatus = 500;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (url === hook) {
        bodies.push(String(init?.body));
        return new Response(null, { status: webhookStatus });
      }
      if (url === DELIVERY_LOG_PATH) {
        reports.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }
      throw new Error("Unexpected request");
    });

    const { default: App } = await import("../src/App");
    render(<App />);
    const task = within(row("Call the vendor"));
    fireEvent.click(task.getByRole("button", { name: "Message your assistant about Call the vendor" }));
    const field = task.getByRole("textbox", { name: "Message to your assistant about Call the vendor" });
    expect(within(row("Pay rent")).queryByRole("textbox")).toBeNull();
    fireEvent.change(field, { target: { value: "  Please follow up.  " } });
    fireEvent.click(task.getByRole("button", { name: "Send" }));
    expect(task.getByText("Sending...")).toBeTruthy();
    await flush();

    const [queued] = Object.values(loadMessages(window.localStorage));
    expect(queued.payload).toEqual({
      event: "todo.message",
      message_id: expect.any(String),
      todo_id: "b",
      name: "Call the vendor",
      priority: "urgent",
      due: fixture.items[1].due,
      comments: fixture.items[1].comments,
      links: [],
      text: "Please follow up.",
      sent_at: expect.any(String),
    });
    expect(queued.status).toBe("pending");
    expect(bodies).toEqual([JSON.stringify(queued.payload)]);

    await act(async () => void (await vi.advanceTimersByTimeAsync(2500)));
    expect(task.getByText("Not delivered, will retry")).toBeTruthy();
    webhookStatus = 200;
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(task.getByText(/^Sent to your assistant/)).toBeTruthy();
    expect(task.queryByRole("textbox")).toBeNull();
    expect(bodies).toEqual(Array(4).fill(bodies[0]));
    expect(reports.at(-1)).toMatchObject({ event: "todo.message", message_id: queued.payload.message_id, todo_id: "b", status: "delivered" });
  });

  it("renders no date controls or labels in open or completed to-dos, including expanded details", async () => {
    await renderList();
    fireEvent.click(within(row("Call the vendor")).getByRole("button", { name: "Call the vendor" }));
    fireEvent.click(doneToggle());
    fireEvent.click(within(row("Old thing")).getByRole("button", { name: "Old thing" }));
    const panel = screen.getByRole("region", { name: /^To-do/ });
    expect(panel.querySelector('time, input[type="date"], input[type="time"], [data-overdue]')).toBeNull();
    expect(within(panel).queryByRole("group", { name: "To-do views" })).toBeNull();
    expect(panel.textContent).not.toMatch(/today|upcoming|yesterday|no date|due date|3:00|late/i);
    expect(screen.getByRole("textbox", { name: "Add a to-do" }).getAttribute("placeholder")).toBe("Add a to-do: call the vendor p1");
  });

  it("quick add keeps date words in the name and adds the task to the open list", async () => {
    await renderList();
    const input = screen.getByRole("textbox", { name: "Add a to-do" });
    fireEvent.change(input, { target: { value: "call the vendor Friday 3pm p1" } });
    await act(async () => fireEvent.submit(input.closest("form")!));
    expect(posted).toEqual([{ action: "add", name: "call the vendor Friday 3pm", priority: "urgent" }]);
    expect((input as HTMLInputElement).value).toBe("");
    expect(document.getElementById("todo-add-note")!.textContent).toBe('Added "call the vendor Friday 3pm".');
    expect(names().slice(0, 2)).toEqual(["Call the vendor", "call the vendor Friday 3pm"]);
  });

  it("quick add refuses priority alone", async () => {
    await renderList();
    const input = screen.getByRole("textbox", { name: "Add a to-do" });
    fireEvent.change(input, { target: { value: "p1" } });
    await act(async () => fireEvent.submit(input.closest("form")!));
    expect(posted).toEqual([]);
    expect((input as HTMLInputElement).value).toBe("p1");
    expect(document.getElementById("todo-add-note")!.textContent).toBe("Add a name besides the priority.");
  });

  it("moves a completed to-do out of the open list and into Done", async () => {
    await renderList();
    await act(async () => fireEvent.click(within(row("Send invoice")).getByRole("checkbox", { name: "Complete Send invoice" })));
    expect(posted).toEqual([{ action: "done", id: "c" }]);
    expect(names()).not.toContain("Send invoice");
    expect(doneToggle().textContent).toBe("Done (4)");
    expect(row("Send invoice")).toBeUndefined();
    fireEvent.click(doneToggle());
    expect(names("Done to-dos")[0]).toBe("Send invoice");
  });

  it("reopens from Done", async () => {
    await renderList();
    fireEvent.click(doneToggle());
    await act(async () => fireEvent.click(within(row("Old thing")).getByRole("button", { name: "Reopen" })));
    expect(posted).toEqual([{ action: "reopen", id: "g" }]);
    expect(names("Done to-dos")).toEqual(["Find number", "Older thing"]);
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
    expect([...row("Call the vendor").querySelectorAll(".todo-subtask span")].map((e) => e.textContent)).toEqual(["Prep notes"]);
    expect(row("Call the vendor").querySelector(".todo-comment")!.textContent).toContain("left a voicemail");
    expect(row("Call the vendor").querySelector(".todo-comment-meta")!.textContent).toBe("bot");

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
    expect(names()).toContain("Pay rent");
  });

  it("follows live todos events on the shared stream", async () => {
    await renderList();
    const es = FakeEventSource.instances.at(-1)!;
    const next: Todos = { updated_at: LATER, items: [t("z", "Brand new", { due: { date: "2026-11-26" } })] };
    act(() => void es.dispatchEvent(new MessageEvent("todos", { data: JSON.stringify(next) })));
    expect(names()).toEqual(["Brand new"]);
    expect(doneToggle().textContent).toBe("Done (0)");
    act(() => void es.dispatchEvent(new MessageEvent("todos", { data: '{"items":"nope"}' })));
    expect(names()).toEqual(["Brand new"]);
    await flush();
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === TODOS_PATH)).toHaveLength(0);
  });
});
