import { useEffect, useState } from "react";

export const NOW_MS = 60_000;

// One shared clock for the board: the current time, refreshed every intervalMs, so time-relative text
// (a card stamp that is "today" until midnight Eastern) updates without new board data or a reload.
export function useNow(intervalMs = NOW_MS): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
