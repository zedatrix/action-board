import type { Board, Decision, OtherPR, Ticket, Todo, WaitingItem } from "./data/types";
import { findUrls } from "./linkify";

export type GlanceSection = Exclude<keyof Board["glance"], "parked">;
export type ItemSection = "decision" | GlanceSection;

// A board item as a "Message <assistant>" note names it, in payload field names. Optional fields are absent, never null.
export type BoardItem = {
  item_id: string;
  item_section: ItemSection;
  item_title: string;
  item_who?: string;
  item_status?: string;
  item_link?: string;
};

export type MessagePayload = { event: "item.message"; message_id: string } & BoardItem & { text: string; sent_at: string };
export type TodoMessagePayload = {
  event: "todo.message";
  message_id: string;
  todo_id: string;
  name: string;
  description?: string;
  priority: Todo["priority"];
  due: NonNullable<Todo["due"]> | null;
  comments: Todo["comments"];
  links: string[];
  text: string;
  sent_at: string;
};

const present = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export const SLUG_MAX = 80;

// Lowercase, every run of non-alphanumerics becomes "-", no leading or trailing "-", at most SLUG_MAX chars.
export function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return s || "untitled";
}

// item_id of a glance item: a ticket's id; otherwise the item's link; otherwise "<section>:<slug(title)>".
// Depends only on the item's own fields, so it stays the same across board edits and reorders.
export function glanceItemId(section: string, item: { title: string; id?: string; link?: string }): string {
  if (section === "tickets" && present(item.id)) return item.id;
  if (present(item.link)) return item.link;
  return `${section}:${slug(item.title)}`;
}

export function decisionItem(d: Decision): BoardItem {
  // Decisions have no link field today; pass one through if the file ever adds it.
  const link = (d as Decision & { link?: unknown }).link;
  return { item_id: d.id, item_section: "decision", item_title: d.question, ...(present(link) ? { item_link: link } : {}) };
}

// An OtherPR's author has no BoardItem field; its title, who and link are enough for the assistant.
export function glanceItem(section: GlanceSection, item: WaitingItem | Ticket | OtherPR): BoardItem {
  const x = item as Partial<WaitingItem & Ticket>;
  return {
    item_id: glanceItemId(section, item),
    item_section: section,
    item_title: item.title,
    ...(present(x.who) ? { item_who: x.who } : {}),
    ...(present(x.status) ? { item_status: x.status } : {}),
    ...(present(x.link) ? { item_link: x.link } : {}),
  };
}

// Key for per-item UI state. item_id alone can repeat across sections (a PR both waiting and a ticket).
export const itemKey = (item: Pick<BoardItem, "item_id" | "item_section">) => `${item.item_section}|${item.item_id}`;
export const todoMessageKey = (id: string) => `todo|${id}`;

// crypto.randomUUID only exists in secure contexts, and a plain http:// host name may not be one.
export function newMessageId(c: Pick<Crypto, "getRandomValues"> & { randomUUID?: () => string } = globalThis.crypto): string {
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// The item.message payload, fields in a fixed order. Throws on blank text; the text is trimmed.
export function buildMessagePayload(item: BoardItem, text: string, now: Date, messageId: string): MessagePayload {
  const t = text.trim();
  if (!t) throw new Error("Message is blank");
  const opt = (k: "item_who" | "item_status" | "item_link") => (present(item[k]) ? { [k]: item[k] } : {});
  return {
    event: "item.message",
    message_id: messageId,
    item_id: item.item_id,
    item_section: item.item_section,
    item_title: item.item_title,
    ...opt("item_who"),
    ...opt("item_status"),
    ...opt("item_link"),
    text: t,
    sent_at: now.toISOString(),
  };
}

export function buildTodoMessagePayload(todo: Todo, text: string, now: Date, messageId: string): TodoMessagePayload {
  const t = text.trim();
  if (!t) throw new Error("Message is blank");
  // To-dos hold links in their text fields. Keep each URL once, in order of appearance.
  const links = new Set<string>();
  for (const field of [todo.name, todo.description ?? "", ...todo.comments.map((comment) => comment.text)]) {
    for (const { url } of findUrls(field)) links.add(url);
  }
  return {
    event: "todo.message",
    message_id: messageId,
    todo_id: todo.id,
    name: todo.name,
    ...(present(todo.description) ? { description: todo.description } : {}),
    priority: todo.priority,
    due: todo.due ?? null,
    comments: todo.comments,
    links: [...links],
    text: t,
    sent_at: now.toISOString(),
  };
}
