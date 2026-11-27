import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../src/quickadd";

describe("parseQuickAdd", () => {
  it("keeps date and time text in the name", () => {
    expect(parseQuickAdd("call the vendor Friday 3pm p1")).toEqual({ name: "call the vendor Friday 3pm", priority: "urgent" });
    expect(parseQuickAdd("tomorrow")).toEqual({ name: "tomorrow" });
    expect(parseQuickAdd("p2 review on Dec 3 at 9:30")).toEqual({ name: "review on Dec 3 at 9:30", priority: "high" });
  });

  it("reads priority tokens, with the first token setting priority", () => {
    expect(parseQuickAdd("tidy desk !p3")).toEqual({ name: "tidy desk", priority: "medium" });
    expect(parseQuickAdd("water plants P4")).toEqual({ name: "water plants", priority: "low" });
    expect(parseQuickAdd("!urgent ship the fix")).toEqual({ name: "ship the fix", priority: "urgent" });
    expect(parseQuickAdd("p2 plan p1 trip")).toEqual({ name: "plan trip", priority: "high" });
    expect(parseQuickAdd("update p10 report and app1")).toEqual({ name: "update p10 report and app1" });
    expect(parseQuickAdd("!LOW p1")).toEqual({ name: "", priority: "low" });
  });

  it("preserves the remaining text and internal whitespace", () => {
    expect(parseQuickAdd("  buy   printer paper  ")).toEqual({ name: "buy   printer paper" });
    expect(parseQuickAdd("pick up p3 supplies  for tomorrow")).toEqual({ name: "pick up supplies  for tomorrow", priority: "medium" });
  });
});
