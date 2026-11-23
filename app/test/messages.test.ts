import { describe, expect, it } from "vitest";
import type { Decision } from "../src/data/types";
import { buildMessagePayload, decisionItem, glanceItem, glanceItemId, itemKey, newMessageId, slug } from "../src/messages";

const NOW = new Date("2026-11-10T12:34:56.789Z");
const MID = "00000000-0000-4000-8000-000000000001";

const decision: Decision = {
  id: "merge-42",
  card_ref: "PROJ-4382",
  question: "Merge now or wait?",
  what_happens_after: "The assistant merges it.",
  options: [{ id: "merge", label: "Merge now" }],
  created_at: "2026-11-10T09:00:00.000Z",
};

describe("glanceItemId", () => {
  it("uses a ticket's id, even when it has a link", () => {
    expect(glanceItemId("tickets", { id: "PROJ-5067", title: "Align weeks", link: "https://example.com/tickets/PROJ-5067" })).toBe("PROJ-5067");
  });

  it("uses the link when there is no ticket id", () => {
    const link = "https://github.com/acme/example/pull/101";
    expect(glanceItemId("waiting", { title: "Analytics dashboard", link })).toBe(link);
    expect(glanceItemId("tickets", { id: "  ", title: "No id", link })).toBe(link);
    // Only tickets use an id; any other section goes by link.
    expect(glanceItemId("waiting", { id: "X-1", title: "Has id", link } as never)).toBe(link);
  });

  it("falls back to <section>:<slug(title)>", () => {
    expect(glanceItemId("waiting", { title: "Blake's re-review: #101 (backend)" })).toBe("waiting:blake-s-re-review-101-backend");
    expect(glanceItemId("waiting", { title: "  Whether to reply to Sage?  ", link: "" })).toBe("waiting:whether-to-reply-to-sage");
    expect(glanceItemId("tickets", { id: "", title: "Ticket without id" })).toBe("tickets:ticket-without-id");
    expect(glanceItemId("waiting", { title: "!!!" })).toBe("waiting:untitled");
  });

  it("is stable: same item, same id, regardless of position or other fields", () => {
    const a = { title: "Save changes label (#1530)", who: "QA" };
    expect(glanceItemId("waiting", a)).toBe(glanceItemId("waiting", { ...a, who: "Someone else" } as never));
    expect(glanceItemId("waiting", a)).toBe("waiting:save-changes-label-1530");
  });
});

describe("slug", () => {
  it("lowercases, joins non-alphanumerics with one dash, trims dashes, and caps at 80 chars", () => {
    expect(slug("Hello,   World!!")).toBe("hello-world");
    expect(slug("Ünïcode café")).toBe("n-code-caf");
    const long = slug("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("-")).toBe(false);
    expect(slug("a".repeat(100))).toBe("a".repeat(80));
  });
});

describe("buildMessagePayload", () => {
  it("decision: item_id is the decision id, item_title the question, no link/status", () => {
    expect(JSON.stringify(buildMessagePayload(decisionItem(decision), "  Hold off until Riley is back  ", NOW, MID))).toBe(
      '{"event":"item.message","message_id":"00000000-0000-4000-8000-000000000001","item_id":"merge-42","item_section":"decision",' +
        '"item_title":"Merge now or wait?","text":"Hold off until Riley is back","sent_at":"2026-11-10T12:34:56.789Z"}',
    );
  });

  it("decision with a link field passes it through as item_link", () => {
    const p = buildMessagePayload(decisionItem({ ...decision, link: "https://github.com/x/y/pull/1" } as Decision), "x", NOW, MID);
    expect(p.item_link).toBe("https://github.com/x/y/pull/1");
  });

  it("waiting: item_who, item_link", () => {
    const item = glanceItem("waiting", { title: "Analytics dashboard (#101)", who: "Blake's re-review", link: "https://github.com/acme/example/pull/101" });
    expect(JSON.stringify(buildMessagePayload(item, "Nudge Blake", NOW, MID))).toBe(
      '{"event":"item.message","message_id":"00000000-0000-4000-8000-000000000001","item_id":"https://github.com/acme/example/pull/101",' +
        '"item_section":"waiting","item_title":"Analytics dashboard (#101)","item_who":"Blake\'s re-review",' +
        '"item_link":"https://github.com/acme/example/pull/101","text":"Nudge Blake","sent_at":"2026-11-10T12:34:56.789Z"}',
    );
  });

  it("waiting without a link: slug id, no item_link", () => {
    const item = glanceItem("waiting", { title: "QA pass", who: "QA" });
    expect(buildMessagePayload(item, "x", NOW, MID)).toStrictEqual({
      event: "item.message",
      message_id: MID,
      item_id: "waiting:qa-pass",
      item_section: "waiting",
      item_title: "QA pass",
      item_who: "QA",
      text: "x",
      sent_at: "2026-11-10T12:34:56.789Z",
    });
  });

  it("a blank who is left out rather than sent empty or null", () => {
    const bare = buildMessagePayload(glanceItem("waiting", { title: "Bare", who: " " }), "x", NOW, MID);
    expect(Object.keys(bare)).toEqual(["event", "message_id", "item_id", "item_section", "item_title", "text", "sent_at"]);
    expect(JSON.stringify(bare)).not.toContain("null");
  });

  it("tickets: item_id is the ticket id, item_title the title alone, item_status", () => {
    const item = glanceItem("tickets", { id: "PROJ-5067", title: "Align weeks to the Friday cutoff", status: "In Progress", link: "https://example.com/tickets/PROJ-5067" });
    expect(JSON.stringify(buildMessagePayload(item, "Ship it Friday", NOW, MID))).toBe(
      '{"event":"item.message","message_id":"00000000-0000-4000-8000-000000000001","item_id":"PROJ-5067","item_section":"tickets",' +
        '"item_title":"Align weeks to the Friday cutoff","item_status":"In Progress","item_link":"https://example.com/tickets/PROJ-5067",' +
        '"text":"Ship it Friday","sent_at":"2026-11-10T12:34:56.789Z"}',
    );
    const noLink = buildMessagePayload(glanceItem("tickets", { id: "PROJ-1", title: "T", status: "To Do" }), "x", NOW, MID);
    expect(Object.keys(noLink)).toEqual(["event", "message_id", "item_id", "item_section", "item_title", "item_status", "text", "sent_at"]);
  });

  it("rejects blank and whitespace-only text", () => {
    for (const t of ["", "   ", "\n\t "]) expect(() => buildMessagePayload(decisionItem(decision), t, NOW, MID)).toThrow(/blank/);
  });
});

describe("itemKey and newMessageId", () => {
  it("keys items by section and item_id, so the same PR waiting and as a ticket stays apart", () => {
    const link = "https://github.com/acme/example-web/pull/1461";
    const a = glanceItem("waiting", { title: "A", who: "Riley", link });
    const b = glanceItem("tickets", { id: "", title: "B", status: "To Do", link });
    expect(a.item_id).toBe(b.item_id);
    expect(itemKey(a)).not.toBe(itemKey(b));
  });

  it("uses randomUUID when there is one, and builds a v4 UUID from getRandomValues when not (a plain http:// host)", () => {
    expect(newMessageId({ randomUUID: () => "from-random-uuid", getRandomValues: (a) => a })).toBe("from-random-uuid");
    // What an insecure context has: getRandomValues but no randomUUID.
    const insecure = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) };
    const ids = new Set(Array.from({ length: 50 }, () => newMessageId(insecure)));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
