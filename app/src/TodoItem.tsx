import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { Todo } from "./data/types";
import { linkify } from "./linkify";
import type { Send, TodoAction } from "./todoActions";
import { isDone, nextPriority, openSubtasks, subtaskProgress, TODO_PRIORITIES } from "./todos";

type Props = {
  todo: Todo;
  // The whole list, for subtasks.
  items: Todo[];
  expanded: boolean;
  onToggle: (id: string) => void;
  send: Send;
  message: ReactNode;
};

export function TodoItem({ todo, items, expanded, onToggle, send, message }: Props) {
  const [busy, setBusy] = useState(false);
  const run = async (body: TodoAction) => {
    if (busy) return;
    setBusy(true);
    await send(body);
    setBusy(false);
  };
  const done = isDone(todo);
  const progress = subtaskProgress(items, todo.id);
  const n = todo.comments.length;

  return (
    <li className="todo" data-todo-id={todo.id} data-priority={todo.priority} data-done={done || undefined}>
      <div className="todo-row">
        <input
          type="checkbox"
          className="todo-check"
          aria-label={`Complete ${todo.name}`}
          checked={done}
          disabled={busy}
          onChange={() => void run({ action: done ? "reopen" : "done", id: todo.id })}
        />
        <button type="button" className="todo-name" aria-expanded={expanded} onClick={() => onToggle(todo.id)}>
          {todo.priority === "urgent" && (
            <span className="todo-urgent" title="Urgent" aria-hidden="true">
              !
            </span>
          )}
          <span className="todo-title">{todo.name}</span>
        </button>
        <div className="todo-chips">
          <button
            type="button"
            className="todo-chip todo-prio"
            data-level={todo.priority}
            aria-label={`Priority ${todo.priority}, tap for ${nextPriority(todo.priority)}`}
            disabled={busy}
            onClick={() => void run({ action: "update", id: todo.id, priority: nextPriority(todo.priority) })}
          >
            {todo.priority}
          </button>
          {progress && (
            <span className="todo-chip todo-subs" aria-label={`${progress.done} of ${progress.total} subtasks done`}>
              {progress.done}/{progress.total}
            </span>
          )}
          {n > 0 && (
            <span className="todo-chip todo-comments" aria-label={`${n} ${n === 1 ? "comment" : "comments"}`}>
              {n}
            </span>
          )}
        </div>
        {message}
        {done && (
          <button type="button" className="not-relevant-btn todo-reopen" disabled={busy} onClick={() => void run({ action: "reopen", id: todo.id })}>
            Reopen
          </button>
        )}
      </div>
      {expanded && <TodoDetails todo={todo} items={items} send={send} />}
    </li>
  );
}

// The expanded to-do: name, description, priority, subtasks and comments, each saved as it changes.
function TodoDetails({ todo, items, send }: { todo: Todo; items: Todo[]; send: Send }) {
  const id = todo.id;
  // Typed but not yet saved; null shows the to-do's own value (so live updates show through).
  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [subtask, setSubtask] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (body: TodoAction) => {
    setBusy(true);
    const ok = await send(body);
    setBusy(false);
    return ok;
  };

  const saveName = async () => {
    if (name === null) return;
    if (name.trim() && name.trim() !== todo.name) await run({ action: "update", id, name: name.trim() });
    setName(null);
  };
  const saveDescription = async () => {
    if (description === null) return;
    if (description.trim() !== (todo.description ?? "")) await run({ action: "update", id, description: description.trim() || null });
    setDescription(null);
  };
  const addSubtask = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !subtask.trim()) return;
    if (await run({ action: "add", name: subtask.trim(), parent_id: id })) setSubtask("");
  };
  const addComment = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !comment.trim()) return;
    if (await run({ action: "comment", id, text: comment.trim() })) setComment("");
  };
  const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  const subs = todo.parent_id ? null : openSubtasks(items, id);

  return (
    <div className="todo-details">
      <label className="todo-field">
        <span className="todo-label">Name</span>
        <input
          className="custom-input"
          value={name ?? todo.name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void saveName()}
          onKeyDown={blurOnEnter}
        />
      </label>
      <label className="todo-field">
        <span className="todo-label">Description</span>
        <textarea
          className="composer-input"
          value={description ?? todo.description ?? ""}
          maxLength={4000}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => void saveDescription()}
        />
      </label>
      <div className="todo-field">
        <span className="todo-label" id={`prio-${id}`}>
          Priority
        </span>
        <div className="priority todo-priority" role="group" aria-labelledby={`prio-${id}`}>
          {TODO_PRIORITIES.map((p) => (
            <button
              key={p}
              type="button"
              className={`priority-seg todo-seg-${p}`}
              aria-pressed={todo.priority === p}
              disabled={busy}
              onClick={() => todo.priority !== p && void run({ action: "update", id, priority: p })}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      {subs && (
        <div className="todo-field">
          <span className="todo-label">Subtasks</span>
          {subs.length > 0 && (
            <ul className="todo-subtasks">
              {subs.map((s) => (
                <li key={s.id} className="todo-subtask">
                  <label>
                    <input
                      type="checkbox"
                      className="todo-check"
                      checked={false}
                      disabled={busy}
                      onChange={() => void run({ action: "done", id: s.id })}
                    />
                    <span>{s.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <form className="todo-inline-form" onSubmit={addSubtask}>
            <input className="custom-input" aria-label="Add a subtask" placeholder="Add a subtask" value={subtask} maxLength={200} onChange={(e) => setSubtask(e.target.value)} />
            <button type="submit" className="btn ghost" disabled={busy || !subtask.trim()}>
              Add
            </button>
          </form>
        </div>
      )}
      <div className="todo-field">
        <span className="todo-label">Comments</span>
        {todo.comments.length > 0 && (
          <ol className="todo-thread">
            {todo.comments.map((c) => (
              <li key={c.id} className="todo-comment">
                <span className="todo-comment-meta">{c.author}</span>
                <p>{linkify(c.text)}</p>
              </li>
            ))}
          </ol>
        )}
        <form className="todo-inline-form" onSubmit={addComment}>
          <input className="custom-input" aria-label="Add a comment" placeholder="Add a comment" value={comment} maxLength={4000} onChange={(e) => setComment(e.target.value)} />
          <button type="submit" className="btn ghost" disabled={busy || !comment.trim()}>
            Comment
          </button>
        </form>
      </div>
    </div>
  );
}
