import type { Project } from "./types";
// The project tab: one entry per milestone. "title" is the tab's label and heading; "parent" links the whole project.
// Rewrite it with `node bin/ab.mjs project-refresh`. Everything between the two marker lines must stay valid JSON.
// Shape (types in ./types.ts):
//   { title, updated_at (ISO UTC), parent: { id, url }, milestones: [{ key, id, title, url, done, in_progress, left, total }] }
//   Counts leave out duplicate and canceled tickets. left includes in_progress, so done + left = total.
//   The "All milestones" line on the page is summed from the milestones; it is not stored here.
export const project: Project =
/* PROJECT-JSON-START */
{
  "title": "Website relaunch",
  "updated_at": "2026-11-23T18:35:00.000Z",
  "parent": {
    "id": "PROJ-100",
    "url": "https://example.com/tickets/PROJ-100"
  },
  "milestones": [
    {
      "key": "M1",
      "id": "PROJ-101",
      "title": "Design and content",
      "url": "https://example.com/tickets/PROJ-101",
      "done": 12,
      "in_progress": 0,
      "left": 0,
      "total": 12
    },
    {
      "key": "M2",
      "id": "PROJ-102",
      "title": "Build the new pages",
      "url": "https://example.com/tickets/PROJ-102",
      "done": 9,
      "in_progress": 3,
      "left": 6,
      "total": 15
    },
    {
      "key": "M3",
      "id": "PROJ-103",
      "title": "Search and redirects",
      "url": "https://example.com/tickets/PROJ-103",
      "done": 2,
      "in_progress": 1,
      "left": 8,
      "total": 10
    },
    {
      "key": "M4",
      "id": "PROJ-104",
      "title": "Launch checklist",
      "url": "https://example.com/tickets/PROJ-104",
      "done": 0,
      "in_progress": 0,
      "left": 7,
      "total": 7
    }
  ]
}
/* PROJECT-JSON-END */
;
