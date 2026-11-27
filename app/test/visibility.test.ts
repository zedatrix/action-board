import { describe, expect, it } from "vitest";
import type { Decision } from "../src/data/types";
import { needsYou } from "../src/visibility";

const decision = (id: string, answer?: Decision["answer"]): Decision => ({
  id,
  card_ref: null,
  question: `Question ${id}?`,
  what_happens_after: "Something happens.",
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  created_at: "2026-11-10T09:00:00.000Z",
  ...(answer ? { answer } : {}),
});

const chatYes = { answer: "yes", answer_label: "Yes", answered_by: "chat" as const, answered_at: "2026-11-10T10:00:00.000Z" };

describe("needsYou", () => {
  it("shows decisions with no file answer and no app answer, in file order", () => {
    expect(needsYou([decision("a"), decision("b")], {}).map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("hides a decision the file has answered", () => {
    expect(needsYou([decision("a", chatYes), decision("b")], {}).map((d) => d.id)).toEqual(["b"]);
  });

  it("hides a decision answered in this browser", () => {
    expect(needsYou([decision("a"), decision("b")], { a: { status: "pending" } }).map((d) => d.id)).toEqual(["b"]);
  });

  it("file answer wins over a different local answer", () => {
    const local = { a: { payload: { answer: "no" }, status: "delivered" } };
    const shown = needsYou([decision("a", chatYes)], local);
    expect(shown).toEqual([]);
  });

  it("hides a decision the file answered in any shape: single, multi, custom", () => {
    const at = { answered_by: "chat" as const, answered_at: "2026-11-10T10:00:00.000Z" };
    const multi = { answer: ["yes", "no"], answer_label: ["Yes", "No"], ...at };
    const custom = { answer: "custom" as const, answer_label: "Neither", custom_text: "Neither", ...at };
    const decisions = [decision("s", chatYes), decision("m", multi), decision("c", { ...custom, answered_by: "app" }), decision("open")];
    expect(needsYou(decisions, {}).map((d) => d.id)).toEqual(["open"]);
  });

  it("file answer wins over a local answer of a different shape", () => {
    const custom = { answer: "custom" as const, answer_label: "Neither", custom_text: "Neither", answered_by: "chat" as const, answered_at: "2026-11-10T10:00:00.000Z" };
    const local = { a: { payload: { answer: ["yes", "no"], answer_label: ["Yes", "No"] }, status: "failed" } };
    expect(needsYou([decision("a", custom)], local)).toEqual([]);
    expect(needsYou([decision("a", chatYes)], { a: { payload: { answer: "custom", custom_text: "x" }, status: "pending" } })).toEqual([]);
  });

  it("ignores local answers for ids not in the file", () => {
    expect(needsYou([decision("a")], { gone: { status: "failed" } }).map((d) => d.id)).toEqual(["a"]);
  });
});
