import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { board } from "../src/data/board";
import { parseBoardSource } from "../src/data/parse";

const FILE = fileURLToPath(new URL("../src/data/board.ts", import.meta.url));
const START = "/* BOARD-JSON-START */";
const END = "/* BOARD-JSON-END */";

const isStr = (v: unknown) => typeof v === "string" && v.length > 0;
const isIso = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v)) && v.endsWith("Z");
const optLink = (o: any) => o.link === undefined || isStr(o.link);
const onlyKeys = (o: object, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const detailOk = (e: any) =>
  (isStr(e) && e.trim().length > 0) ||
  (!!e &&
    typeof e === "object" &&
    onlyKeys(e, ["label", "items", "ordered"]) &&
    isStr(e.label) &&
    e.label.trim().length > 0 &&
    Array.isArray(e.items) &&
    e.items.length > 0 &&
    e.items.every((x: any) => isStr(x) && x.trim().length > 0) &&
    (e.ordered === undefined || typeof e.ordered === "boolean"));

// Single: an option id and its label. Multi: option ids and labels in option order. Custom: "custom" plus the text.
function answerShapeOk(d: any, a: any): boolean {
  const byId = new Map(d.options.map((o: any) => [o.id, o.label]));
  if (a.answer === "custom") {
    return d.allowCustom !== false && isStr(a.custom_text) && a.custom_text === a.custom_text.trim() && a.answer_label === a.custom_text;
  }
  if (a.custom_text !== undefined) return false;
  if (Array.isArray(a.answer)) {
    const inOrder = d.options.filter((o: any) => a.answer.includes(o.id)).map((o: any) => o.id);
    return (
      d.multiSelect === true &&
      a.answer.length > 0 &&
      JSON.stringify(a.answer) === JSON.stringify(inOrder) &&
      JSON.stringify(a.answer_label) === JSON.stringify(a.answer.map((id: string) => byId.get(id)))
    );
  }
  return !d.multiSelect && byId.has(a.answer) && a.answer_label === byId.get(a.answer);
}

function checkBoard(b: any): string[] {
  const errors: string[] = [];
  const need = (ok: boolean, what: string) => ok || errors.push(what);
  // hot is the optional HOT toggle map (Board.hot), written by ab hot / ab unhot and the PRs tab flame.
  need(onlyKeys(b, ["updated_at", "decisions", "glance", "hot"]), "top-level keys");
  need(isIso(b.updated_at), "updated_at");
  need(Array.isArray(b.decisions), "decisions array");
  for (const d of b.decisions ?? []) {
    need(
      onlyKeys(d, ["id", "title", "card_ref", "link", "context", "question", "details", "what_happens_after", "options", "created_at", "updated_at", "multiSelect", "allowCustom", "priority", "blocking", "blocks", "answer"]),
      `keys of ${d.id}`,
    );
    need(d.priority === undefined || ["high", "medium", "low"].includes(d.priority), `priority of ${d.id}`);
    need(d.blocking === undefined || typeof d.blocking === "boolean", `blocking of ${d.id}`);
    need(d.blocks === undefined || (d.blocking === true && isStr(d.blocks) && d.blocks.trim().length > 0), `blocks of ${d.id}`);
    need(d.context === undefined || (isStr(d.context) && d.context.trim().length > 0), `context of ${d.id}`);
    need(d.multiSelect === undefined || typeof d.multiSelect === "boolean", `multiSelect of ${d.id}`);
    need(d.allowCustom === undefined || typeof d.allowCustom === "boolean", `allowCustom of ${d.id}`);
    need(d.details === undefined || (Array.isArray(d.details) && d.details.length > 0 && d.details.every(detailOk)), `details of ${d.id}`);
    need(isStr(d.id) && isStr(d.question) && isStr(d.what_happens_after), `strings of ${d.id}`);
    need(d.card_ref === null || isStr(d.card_ref), `card_ref of ${d.id}`);
    need(d.link === undefined || (isStr(d.link) && d.link.trim().length > 0), `link of ${d.id}`);
    need(isIso(d.created_at), `created_at of ${d.id}`);
    need(d.updated_at === undefined || isIso(d.updated_at), `updated_at of ${d.id}`);
    need(Array.isArray(d.options) && d.options.length > 0 && d.options.every((o: any) => isStr(o.id) && isStr(o.label)), `options of ${d.id}`);
    if (d.answer !== undefined) {
      const a = d.answer;
      need(answerShapeOk(d, a), `answer of ${d.id}`);
      need(a.answered_by === "chat" || a.answered_by === "app", `answered_by of ${d.id}`);
      need(isIso(a.answered_at), `answered_at of ${d.id}`);
    }
  }
  const g = b.glance ?? {};
  need(onlyKeys(g, ["waiting", "parked", "tickets", "others"]), "glance keys");
  need(
    g.others === undefined ||
      (Array.isArray(g.others) &&
        g.others.every(
          (o: any) =>
            !!o && typeof o === "object" && onlyKeys(o, ["title", "author", "who", "link"]) &&
            ["title", "author", "who", "link"].every((k) => isStr(o[k]) && o[k].trim().length > 0) && /^https?:\/\//.test(o.link),
        )),
    "glance.others",
  );
  need(Array.isArray(g.waiting) && g.waiting.every((w: any) => isStr(w.title) && isStr(w.who) && optLink(w)), "glance.waiting");
  need(g.parked === undefined || (Array.isArray(g.parked) && g.parked.length === 0), "glance.parked (retired; must be missing or empty)");
  need(
    Array.isArray(g.tickets) && g.tickets.every((t: any) => isStr(t.id) && isStr(t.title) && isStr(t.status) && optLink(t)),
    "glance.tickets",
  );
  return errors;
}

describe("board.ts", () => {
  const text = readFileSync(FILE, "utf8");

  it("has exactly one marker pair with valid JSON between them", () => {
    expect(text.split(START).length).toBe(2);
    expect(text.split(END).length).toBe(2);
    const json = text.slice(text.indexOf(START) + START.length, text.indexOf(END));
    const parsed = JSON.parse(json);
    expect(checkBoard(parsed)).toEqual([]);
    expect(parsed).toEqual(board);
    expect(parseBoardSource(text)).toEqual(parsed);
  });

  it("is plain data: a type import, the comment, the export and the markers", () => {
    expect(text.startsWith('import type { Board } from "./types";\n// An example board.')).toBe(true);
    expect(text).toContain(`export const board: Board =\n${START}\n{`);
    expect(text.trimEnd().endsWith(`}\n${END}\n;`)).toBe(true);
  });

  it("accepts the three answer shapes and rejects mismatched ones", () => {
    const at = { answered_by: "chat", answered_at: "2026-11-10T10:00:00.000Z" };
    const d = (extra: object, answer: object) => ({
      updated_at: "2026-11-10T09:00:00.000Z",
      decisions: [
        {
          id: "x",
          card_ref: null,
          question: "Q?",
          what_happens_after: "A.",
          options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
          created_at: "2026-11-10T09:00:00.000Z",
          ...extra,
          answer: { ...answer, ...at },
        },
      ],
      glance: { waiting: [], tickets: [] },
    });
    expect(checkBoard(d({}, { answer: "a", answer_label: "A" }))).toEqual([]);
    expect(checkBoard(d({ multiSelect: true }, { answer: ["a", "b"], answer_label: ["A", "B"] }))).toEqual([]);
    expect(checkBoard(d({}, { answer: "custom", answer_label: "Other", custom_text: "Other" }))).toEqual([]);
    expect(checkBoard(d({ multiSelect: true }, { answer: ["b", "a"], answer_label: ["B", "A"] }))).toEqual(["answer of x"]);
    expect(checkBoard(d({}, { answer: ["a"], answer_label: ["A"] }))).toEqual(["answer of x"]);
    expect(checkBoard(d({ allowCustom: false }, { answer: "custom", answer_label: "Other", custom_text: "Other" }))).toEqual(["answer of x"]);
    expect(checkBoard(d({ multiSelect: "yes" }, { answer: "a", answer_label: "A" }))).toContain("multiSelect of x");
    const ans = { answer: "a", answer_label: "A" };
    expect(checkBoard(d({ details: ["One", { label: "L", items: ["x"], ordered: true }] }, ans))).toEqual([]);
    expect(checkBoard(d({ details: [] }, ans))).toEqual(["details of x"]);
    expect(checkBoard(d({ updated_at: "2026-11-10T10:00:00.000Z" }, ans))).toEqual([]);
    for (const priority of ["high", "medium", "low"]) expect(checkBoard(d({ priority }, ans))).toEqual([]);
    expect(checkBoard(d({ priority: "urgent" }, ans))).toEqual(["priority of x"]);
    expect(checkBoard(d({ updated_at: "yesterday" }, ans))).toEqual(["updated_at of x"]);
    expect(checkBoard(d({ context: "Ticket PROJ-15054 asks for an asterisk on the Address field." }, ans))).toEqual([]);
    expect(checkBoard(d({ context: "  " }, ans))).toEqual(["context of x"]);
    expect(checkBoard(d({ link: "https://example.com/pr/1" }, ans))).toEqual([]);
    expect(checkBoard(d({ link: " " }, ans))).toEqual(["link of x"]);
    expect(checkBoard(d({ details: [{ label: "L", items: [] }] }, ans))).toEqual(["details of x"]);
  });

  it("accepts a glance with or without others, and rejects bad others items", () => {
    const b = (others?: unknown) => ({ updated_at: "2026-11-10T09:00:00.000Z", decisions: [], glance: { waiting: [], tickets: [], ...(others === undefined ? {} : { others }) } });
    const ok = { title: "T", author: "A", who: "Your review requested", link: "https://github.com/o/r/pull/1" };
    expect(checkBoard(b())).toEqual([]);
    expect(checkBoard(b([ok]))).toEqual([]);
    expect(checkBoard(b({}))).toEqual(["glance.others"]);
    expect(checkBoard(b([{ ...ok, link: "ftp://x" }]))).toEqual(["glance.others"]);
    expect(checkBoard(b([{ ...ok, extra: 1 }]))).toEqual(["glance.others"]);
  });

  it("carries the seeded glance", () => {
    expect(board.glance.waiting.length).toBeGreaterThan(0);
    expect(board.glance.parked ?? []).toEqual([]);
    expect(board.glance.tickets.length).toBeGreaterThan(0);
  });
});
