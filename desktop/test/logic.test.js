const test = require("node:test");
const assert = require("node:assert/strict");
const { openCards, openCount, badgeText, newCards, notificationFor, createTracker, tabMenuItems } = require("../logic");

const card = (id, extra = {}) => ({ id, question: `Question ${id}?`, options: [], ...extra });
const answered = { answer: "seen", answer_label: "Seen it", answered_by: "app", answered_at: "2026-11-26T00:00:00Z" };

test("open count ignores answered decisions", () => {
  const board = { decisions: [card("a"), card("b", { answer: answered }), card("c")] };
  assert.equal(openCount(board), 2);
  assert.deepEqual(openCards(board).map((d) => d.id), ["a", "c"]);
});

test("badgeText is empty for zero, else the number", () => {
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(1), "1");
  assert.equal(badgeText(12), "12");
});

test("newCards returns open cards not yet seen", () => {
  const board = { decisions: [card("a"), card("b"), card("c", { answer: answered })] };
  assert.deepEqual(newCards(new Set(["a"]), board).map((d) => d.id), ["b"]);
});

test("first update seeds without fresh cards", () => {
  const t = createTracker();
  const r = t.update({ decisions: [card("a"), card("b")] });
  assert.deepEqual(r, { count: 2, badge: "2", fresh: [] });
});

test("a later added card is fresh exactly once", () => {
  const t = createTracker();
  t.update({ decisions: [card("a")] });
  const r1 = t.update({ decisions: [card("a"), card("b")] });
  assert.equal(r1.count, 2);
  assert.deepEqual(r1.fresh.map((d) => d.id), ["b"]);
  const r2 = t.update({ decisions: [card("a"), card("b")] });
  assert.deepEqual(r2.fresh, []);
});

test("answering a card drops the count and badge", () => {
  const t = createTracker();
  t.update({ decisions: [card("a"), card("b")] });
  const r = t.update({ decisions: [card("a"), card("b", { answer: answered })] });
  assert.equal(r.count, 1);
  assert.equal(r.badge, "1");
  assert.deepEqual(r.fresh, []);
  const none = t.update({ decisions: [card("a", { answer: answered }), card("b", { answer: answered })] });
  assert.equal(none.badge, "");
});

test("a seen id is never re-announced, even after being answered and re-raised", () => {
  const t = createTracker();
  t.update({ decisions: [] });
  assert.equal(t.update({ decisions: [card("x")] }).fresh.length, 1);
  t.update({ decisions: [card("x", { answer: answered })] });
  t.update({ decisions: [] });
  const r = t.update({ decisions: [card("x")] });
  assert.equal(r.count, 1);
  assert.deepEqual(r.fresh, []);
});

test("bad or missing board shape gives count 0 and no fresh", () => {
  const t = createTracker();
  for (const bad of [undefined, null, "nope", 42, {}, { decisions: "x" }, { decisions: [null, 5, "s", {}] }]) {
    assert.deepEqual(t.update(bad), { count: 0, badge: "", fresh: [] });
  }
  assert.equal(openCount(null), 0);
});

test("notificationFor uses title, falls back to trimmed question, trims body", () => {
  const withTitle = notificationFor(card("a", { title: "Cursor spend", context: "Over the alert." }));
  assert.deepEqual(withTitle, { title: "New card: Cursor spend", body: "Over the alert." });

  const q = "  Should we   ship\nthe thing?  ";
  const noTitle = notificationFor({ id: "b", question: q });
  assert.equal(noTitle.title, "New card: Should we ship the thing?");
  assert.equal(noTitle.body, "Should we ship the thing?");

  const long = "word ".repeat(100);
  const n = notificationFor({ id: "c", question: long });
  assert.ok(n.body.length <= 140, `body length ${n.body.length}`);
  assert.ok(n.body.endsWith("…"));
});

test("tabMenuItems numbers the tabs Cmd-1.. in order", () => {
  assert.deepEqual(tabMenuItems(["Board", "PRs", "Website relaunch"]), [
    { label: "Board", accelerator: "CommandOrControl+1", index: 0 },
    { label: "PRs", accelerator: "CommandOrControl+2", index: 1 },
    { label: "Website relaunch", accelerator: "CommandOrControl+3", index: 2 },
  ]);
});

test("tabMenuItems stops at Cmd-9", () => {
  const items = tabMenuItems(Array.from({ length: 12 }, (_, i) => `Tab ${i + 1}`));
  assert.equal(items.length, 9);
  assert.deepEqual(items[8], { label: "Tab 9", accelerator: "CommandOrControl+9", index: 8 });
});

test("tabMenuItems is empty for no tabs", () => {
  assert.deepEqual(tabMenuItems([]), []);
  assert.deepEqual(tabMenuItems(undefined), []);
});
