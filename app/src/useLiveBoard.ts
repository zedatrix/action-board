import { isBoard } from "./data/parse";
import type { Board } from "./data/types";
import { useLiveFeed, type Feed } from "./useLiveFeed";

// Dev-server routes (see server/live.ts): the board as Server-Sent Events, and as plain JSON.
export { EVENTS_PATH, POLL_MS } from "./useLiveFeed";
export const BOARD_PATH = "/__ab/board";

const BOARD_FEED: Feed<Board> = { path: BOARD_PATH, event: "board", check: isBoard };

// The board as the dev server currently has it. Starts from the bundled board.ts, then follows the "board"
// events on /__ab/events, polling /__ab/board while the stream is down (see useLiveFeed).
export function useLiveBoard(initial: Board): Board {
  return useLiveFeed(initial, BOARD_FEED);
}
