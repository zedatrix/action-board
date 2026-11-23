import { TIME_ZONE } from "./config";
import type { ProjectCounts } from "./data/types";

export const PROJECT_COLUMNS: { key: keyof ProjectCounts; label: string }[] = [
  { key: "done", label: "Done" },
  { key: "in_progress", label: "In progress" },
  { key: "left", label: "Left" },
  { key: "total", label: "Total" },
];

// The "All milestones" row: each column summed over the milestones.
export function projectTotals(lines: ProjectCounts[]): ProjectCounts {
  const sum = (k: keyof ProjectCounts) => lines.reduce((n, r) => n + r[k], 0);
  return { done: sum("done"), in_progress: sum("in_progress"), left: sum("left"), total: sum("total") };
}

const ZONED = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

// "Nov 23, 2026, 1:35 PM EST" in the board's time zone. Newer ICU puts a narrow no-break space before AM/PM;
// show a plain space. An unparseable stamp is shown as written.
export function zonedTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : ZONED.format(t).replace(/[  ]/g, " ");
}
