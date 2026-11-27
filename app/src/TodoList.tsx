import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { todos as bundledTodos } from "./data/todos";
import type { Todo } from "./data/types";
import { quickAdd } from "./quickadd";
import { caughtUp, postTodo, withSaved, type Send, type TodoAction } from "./todoActions";
import { TodoItem } from "./TodoItem";
import { doneView, dueLabel, TODO_VIEWS, todayView, upcomingView, viewCounts, type TodoView } from "./todos";
import { useLiveTodos } from "./useLiveTodos";

const SAVE_ERROR = "Could not save. Try again.";

// The Board's to-do list (data/todos.ts, live): quick add, then Today / Upcoming / Done. Every change goes
// through POST /__ab/todo, which runs ab; the live feed then brings it to every open tab.
export function TodoList({ now }: { now: Date }) {
  const feed = useLiveTodos(bundledTodos);
  // To-dos as the POST route returned them, shown until the feed has them too.
  const [saved, setSaved] = useState<Record<string, Todo>>({});
  const [view, setView] = useState<TodoView>("today");
  const [open, setOpen] = useState<Record<string, true>>({});
  const [error, setError] = useState<string | null>(null);

  const items = useMemo(() => withSaved(feed.items, saved), [feed, saved]);

  useEffect(() => {
    setSaved((s) => {
      const done = caughtUp(feed.items, s);
      if (done.length === 0) return s;
      const next = { ...s };
      for (const id of done) delete next[id];
      return next;
    });
  }, [feed]);

  const send: Send = useCallback(async (body: TodoAction) => {
    const { ok, todo } = await postTodo(body);
    setError(ok ? null : SAVE_ERROR);
    if (todo) setSaved((s) => ({ ...s, [todo.id]: todo }));
    return ok;
  }, []);

  const toggle = useCallback((id: string) => {
    setOpen((o) => {
      const next = { ...o };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  }, []);

  const counts = viewCounts(items, now);
  const row = (t: Todo) => <TodoItem key={t.id} todo={t} items={items} now={now} view={view} expanded={!!open[t.id]} onToggle={toggle} send={send} />;

  return (
    <section className="todos" aria-labelledby="todos-heading">
      <h2 className="kicker" id="todos-heading">
        To-do <span className="n">{counts.today}</span>
      </h2>
      <QuickAdd now={now} send={send} />
      {error && (
        <p className="todo-error" role="alert">
          {error}
        </p>
      )}
      <div className="todo-views" role="group" aria-label="To-do views">
        {TODO_VIEWS.map((v) => (
          <button key={v.key} type="button" className="todo-view" aria-pressed={view === v.key} onClick={() => setView(v.key)}>
            {v.label} <span className="n">{counts[v.key]}</span>
          </button>
        ))}
      </div>
      {view === "today" && <List items={todayView(items, now)} empty="Nothing due today." row={row} />}
      {view === "upcoming" &&
        (counts.upcoming === 0 ? (
          <p className="panel-empty todo-empty">Nothing upcoming.</p>
        ) : (
          upcomingView(items, now).map((g) => (
            <section key={g.date ?? "none"} className="todo-day" aria-label={g.label}>
              <h3 className="todo-day-label">{g.label}</h3>
              <List items={g.items} empty="" row={row} />
            </section>
          ))
        ))}
      {view === "done" && <List items={doneView(items)} empty="Nothing done yet." row={row} />}
    </section>
  );
}

function List({ items, empty, row }: { items: Todo[]; empty: string; row: (t: Todo) => ReactNode }) {
  if (items.length === 0) return <p className="panel-empty todo-empty">{empty}</p>;
  return <ul className="todo-list">{items.map(row)}</ul>;
}

// Plain words, Enter adds: "call the vendor Friday 3pm p1". Parsed here (quickadd.ts) and posted as name, priority, due.
function QuickAdd({ now, send }: { now: Date; send: Send }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !text.trim()) return;
    const q = quickAdd(text, new Date());
    if ("error" in q) return setNote({ error: true, text: "Add a name besides the date and priority." });
    setBusy(true);
    const ok = await send({ action: "add", ...q });
    setBusy(false);
    if (!ok) return setNote(null);
    setText("");
    setNote({ error: false, text: `Added "${q.name}"${q.due ? `, due ${dueLabel(q.due, now)}` : ""}.` });
  };

  return (
    <form className="todo-add" onSubmit={submit}>
      <input
        className="custom-input todo-add-input"
        aria-label="Add a to-do"
        aria-describedby="todo-add-note"
        placeholder="Add a to-do: call the vendor Friday 3pm p1"
        value={text}
        maxLength={300}
        onChange={(e) => {
          setText(e.target.value);
          setNote(null);
        }}
      />
      <button type="submit" className="btn todo-add-btn" disabled={busy || !text.trim()}>
        Add
      </button>
      <p id="todo-add-note" className={note?.error ? "todo-note todo-error" : "todo-note"} aria-live="polite">
        {note?.text}
      </p>
    </form>
  );
}
