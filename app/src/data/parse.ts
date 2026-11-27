import type { Board, Todos } from "./types";

export const BOARD_START = "/* BOARD-JSON-START */";
export const BOARD_END = "/* BOARD-JSON-END */";
export const TODOS_START = "/* TODOS-JSON-START */";
export const TODOS_END = "/* TODOS-JSON-END */";

// Enough of a shape check that a bad edit cannot crash the page; board-file.test.ts checks the details.
export function isBoard(v: unknown): v is Board {
  const b = v as Board;
  return (
    !!b &&
    typeof b === "object" &&
    typeof b.updated_at === "string" &&
    Array.isArray(b.decisions) &&
    !!b.glance &&
    Array.isArray(b.glance.waiting) &&
    Array.isArray(b.glance.tickets) &&
    (b.glance.others === undefined || Array.isArray(b.glance.others))
  );
}

// The same kind of check for todos.ts: every item has a string id and name and a comments list.
export function isTodos(v: unknown): v is Todos {
  const t = v as Todos;
  return (
    !!t &&
    typeof t === "object" &&
    typeof t.updated_at === "string" &&
    Array.isArray(t.items) &&
    t.items.every((x) => !!x && typeof x === "object" && typeof x.id === "string" && typeof x.name === "string" && Array.isArray(x.comments))
  );
}

// The JSON between two markers. Throws on missing markers or invalid JSON.
function between(src: string, start: string, end: string, what: string): unknown {
  const i = src.indexOf(start);
  const j = src.indexOf(end);
  if (i < 0 || j < i) throw new Error(`${what} markers missing`);
  return JSON.parse(src.slice(i + start.length, j));
}

// The JSON between the markers in board.ts. Throws on missing markers, invalid JSON or a wrong shape.
export function parseBoardSource(src: string): Board {
  const board = between(src, BOARD_START, BOARD_END, "board");
  if (!isBoard(board)) throw new Error("board JSON has the wrong shape");
  return board;
}

// The JSON between the markers in todos.ts. Throws on missing markers, invalid JSON or a wrong shape.
export function parseTodosSource(src: string): Todos {
  const todos = between(src, TODOS_START, TODOS_END, "todos");
  if (!isTodos(todos)) throw new Error("todos JSON has the wrong shape");
  return todos;
}
