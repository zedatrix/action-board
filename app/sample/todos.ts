import type { Todo, Todos } from "../src/data/types";
import { addDays, easternDate } from "../src/eastern";

const now = new Date();
const today = easternDate(now);
const at = now.toISOString();
const item = (id: string, name: string, fields: Partial<Todo> = {}): Todo =>
  ({ id, name, priority: "medium", comments: [], created_at: at, updated_at: at, ...fields });

export const todos: Todos = {
  updated_at: at,
  items: [
    item("send-preview", "Send the website preview", { priority: "high", due: { date: today } }),
    item("check-mobile", "Check the mobile layout", { parent_id: "send-preview" }),
    item("verify-links", "Verify the navigation links", { parent_id: "send-preview", done_at: at }),
    item("review-feedback", "Review the pilot feedback", { due: { date: addDays(today, 2), time: "14:00" } }),
    item("draft-release-notes", "Draft the release notes", { done_at: at }),
  ],
};
