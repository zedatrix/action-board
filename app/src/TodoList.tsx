import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { todos as bundledTodos } from "./data/todos";
import type { Todo } from "./data/types";
import { parseQuickAdd } from "./quickadd";
import { caughtUp, postTodo, withSaved, type Send, type TodoAction } from "./todoActions";
import { TodoItem } from "./TodoItem";
import { completedTodos, isDone, sortTodos } from "./todos";
import { useLiveTodos } from "./useLiveTodos";

const SAVE_ERROR = "Could not save. Try again.";

// Every change goes through POST /__ab/todo and reaches other tabs through the live feed.
export function TodoList({ renderMessage }: { renderMessage?: (todo: Todo) => ReactNode }) {
  const feed = useLiveTodos(bundledTodos);
  // To-dos as the POST route returned them, shown until the feed has them too.
  const [saved, setSaved] = useState<Record<string, Todo>>({});
  const [showDone, setShowDone] = useState(false);
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

  const active = sortTodos(items.filter((t) => !isDone(t)));
  const done = completedTodos(items);
  const row = (t: Todo) => (
    <TodoItem key={t.id} todo={t} items={items} expanded={!!open[t.id]} onToggle={toggle} send={send} message={renderMessage?.(t)} />
  );

  return (
    <section className="todos" aria-labelledby="todos-heading">
      <h2 className="kicker" id="todos-heading">
        To-do <span className="n">{active.length}</span>
      </h2>
      <QuickAdd send={send} />
      {error && (
        <p className="todo-error" role="alert">
          {error}
        </p>
      )}
      {active.length ? <ul className="todo-list" aria-label="Open to-dos">{active.map(row)}</ul> : <p className="panel-empty todo-empty">No open to-dos.</p>}
      <button type="button" className="todo-done-toggle" aria-expanded={showDone} onClick={() => setShowDone((shown) => !shown)}>
        Done ({done.length})
      </button>
      {showDone && done.length > 0 && <ul className="todo-list" aria-label="Done to-dos">{done.map(row)}</ul>}
    </section>
  );
}

function QuickAdd({ send }: { send: Send }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !text.trim()) return;
    const q = parseQuickAdd(text);
    if (!q.name) return setNote({ error: true, text: "Add a name besides the priority." });
    setBusy(true);
    const ok = await send({ action: "add", ...q });
    setBusy(false);
    if (!ok) return setNote(null);
    setText("");
    setNote({ error: false, text: `Added "${q.name}".` });
  };

  return (
    <form className="todo-add" onSubmit={submit}>
      <input
        className="custom-input todo-add-input"
        aria-label="Add a to-do"
        aria-describedby="todo-add-note"
        placeholder="Add a to-do: call the vendor p1"
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
