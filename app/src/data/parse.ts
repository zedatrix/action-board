import type { Board } from "./types";

export const BOARD_START = "/* BOARD-JSON-START */";
export const BOARD_END = "/* BOARD-JSON-END */";

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

// The JSON between the markers in board.ts. Throws on missing markers, invalid JSON or a wrong shape.
export function parseBoardSource(src: string): Board {
  const i = src.indexOf(BOARD_START);
  const j = src.indexOf(BOARD_END);
  if (i < 0 || j < i) throw new Error("board markers missing");
  const board: unknown = JSON.parse(src.slice(i + BOARD_START.length, j));
  if (!isBoard(board)) throw new Error("board JSON has the wrong shape");
  return board;
}
