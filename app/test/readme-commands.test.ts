import { captureCommand } from "./capture-command";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Board, Decision, Todo, Todos } from "../src/data/types";
import { needsYou } from "../src/visibility";

// Runs the bin/ab.mjs commands from README.md exactly as written, from the root of a temp repo whose
// bin/ab.mjs links to the real one. AB_FILE points at a temp board.ts in that repo.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const AB = "node bin/ab.mjs";
const commands = [...README.matchAll(/```sh\n(node bin\/ab\.mjs [^\n]+)\n```/g)].map((m) => m[1]);
const [raiseCmd, lintCardCmd, answerCmd, answerMultiCmd, answerCustomCmd, clearCmd, restoreCmd, priorityCmd, glanceCmd, hotCmd, unhotCmd, openCmd, checkCmd, lintCmd, backfillCmd, backfillTitlesCmd, projectCmd,
  todoAddCmd, todoUpdateCmd, todoCommentCmd, todoListCmd, todoDoneCmd, todoReopenCmd] = commands;

const repo = mkdtempSync(join(tmpdir(), "ab-readme-"));
const appDir = join(repo, "app");
const file = join(appDir, "src/data/board.ts");
const cleared = join(appDir, ".ab-cleared.jsonl");
const abLog = join(appDir, ".ab-log.jsonl");
const projectFile = join(appDir, "src/data/project.ts");
const todosFile = join(appDir, "src/data/todos.ts");
// The hot/unhot event log: a temp file, never the repo's data/events.jsonl.
const eventsFile = join(repo, "data/events.jsonl");
mkdirSync(join(appDir, "src/data"), { recursive: true });
mkdirSync(join(repo, "bin"));
symlinkSync(join(ROOT, "bin/ab.mjs"), join(repo, "bin/ab.mjs"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const A = "/* BOARD-JSON-START */";
const Z = "/* BOARD-JSON-END */";
const original = readFileSync(join(ROOT, "app/src/data/board.ts"), "utf8");
const glance0 = JSON.parse(original.slice(original.indexOf(A) + A.length, original.indexOf(Z))).glance;

const merge: Decision = {
  id: "vendor-contract-q3",
  title: "Q3 vendor contract renewal",
  card_ref: "https://example.com/contracts/q3-hosting",
  context: "The hosting vendor sent the Q3 contract. It renews at the same monthly price but adds a 12 month minimum term.",
  question: "Approve the Q3 vendor contract?",
  what_happens_after: "The assistant signs the contract and files it.",
  options: [
    { id: "approve", label: "Approve" },
    { id: "hold", label: "Hold for now" },
  ],
  created_at: "2026-11-10T08:00:00.000Z",
};
const notify: Decision = {
  id: "offsite-venue-quotes",
  title: "Team offsite venue quotes",
  card_ref: null,
  context: "The team offsite is planned for March. Three venues have dates open and none have sent prices yet.",
  question: "Which offsite venues should the assistant ask for quotes?",
  what_happens_after: "The assistant emails each venue you pick for a quote.",
  options: [
    { id: "lakeside", label: "Lakeside lodge" },
    { id: "downtown", label: "Downtown loft" },
    { id: "farm", label: "Farm retreat" },
  ],
  multiSelect: true,
  created_at: "2026-11-10T08:00:00.000Z",
};

const DA = "/* TODOS-JSON-START */";
const DZ = "/* TODOS-JSON-END */";
const originalTodos = readFileSync(join(ROOT, "app/src/data/todos.ts"), "utf8");
const todosSeed = originalTodos.slice(0, originalTodos.indexOf(DA) + DA.length) + "\n" + JSON.stringify({ updated_at: "2026-11-26T15:00:00.000Z", items: [] }, null, 2) + "\n" + originalTodos.slice(originalTodos.indexOf(DZ));

// A fresh temp board.ts (the real file's text, with known decisions), an empty temp todos.ts, and no cleared ids or log.
const seed = (decisions: Decision[]) => {
  const b: Board = { updated_at: "2026-11-10T08:00:00.000Z", decisions, glance: glance0 };
  writeFileSync(file, original.slice(0, original.indexOf(A) + A.length) + "\n" + JSON.stringify(b, null, 2) + "\n" + original.slice(original.indexOf(Z)));
  writeFileSync(todosFile, todosSeed);
  rmSync(cleared, { force: true });
  rmSync(abLog, { force: true });
  rmSync(eventsFile, { force: true });
};
beforeEach(() => seed([]));

const run = (cmd: string, extra: NodeJS.ProcessEnv = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env, AB_FILE: file, AB_EVENTS_FILE: eventsFile, AB_NO_SERVER: "1" };
  for (const k of ["AB_URL", "AB_TODOS_FILE", "ACTION_BOARD_HOST", "ACTION_BOARD_PORT", "AB_MAX_HIGH"]) delete env[k];
  Object.assign(env, extra);
  const r = captureCommand("bash", ["-c", cmd], { cwd: repo, env, timeout: 10000 });
  return { status: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
};
const read = (): Board => {
  const s = readFileSync(file, "utf8");
  return JSON.parse(s.slice(s.indexOf(A) + A.length, s.indexOf(Z)));
};
const find = (id: string) => read().decisions.find((x) => x.id === id);
const raiseJson = JSON.parse(raiseCmd.slice(raiseCmd.indexOf("'") + 1, -1));
const raiseWith = (d: object) => `${AB} raise '${JSON.stringify(d)}'`;

// Runs a refused command and checks the exit code, the message, and that board.ts did not change.
const refused = (cmd: string, code: number, msg: RegExp) => {
  const before = readFileSync(file, "utf8");
  const r = run(cmd);
  expect([cmd, r.status]).toEqual([cmd, code]);
  expect(r.err).toMatch(msg);
  expect(readFileSync(file, "utf8")).toBe(before);
};

describe("README ab.mjs commands", () => {
  it("finds one command per subcommand, plus multi-select and free-text answers", () => {
    expect(commands.map((c) => c.split(" ")[2])).toEqual([
      "raise", "lint-card", "answer", "answer", "answer", "clear", "restore", "priority", "glance", "hot", "unhot", "open", "check", "lint", "backfill-stamps", "backfill-titles", "project-refresh",
      "todo-add", "todo-update", "todo-comment", "todo-list", "todo-done", "todo-reopen",
    ]);
    expect(raiseCmd).not.toMatch(/'.*'.*'/);
    expect(answerMultiCmd).toBe(`${AB} answer offsite-venue-quotes lakeside,farm --by app --at 2026-11-10T09:05:00.000Z`);
    expect(answerCustomCmd).toBe(`${AB} answer vendor-contract-q3 --custom "Approve if the term drops to 6 months" --by chat`);
    expect(glanceCmd).toBe(`${AB} glance < glance.json`);
    expect(README).not.toMatch(/```sh\nnode -e/);
  });

  it("raise: writes the decision, keeps the file's wrapper, prints the chat card", () => {
    const r = run(raiseCmd);
    expect(r.status).toBe(0);
    expect(r.json()).toMatchObject({
      ok: true,
      board: "live",
      card: {
        title: "Q3 vendor contract renewal",
        context: raiseJson.context,
        question: merge.question,
        options: ["Approve", "Hold for now"],
        multiSelect: false,
        allowCustom: true,
        link: merge.card_ref,
        decision_id: "vendor-contract-q3",
        priority: "medium",
        blocking: false,
        blocks: null,
        footer: expect.stringContaining("(vendor-contract-q3)"),
      },
    });
    expect(Object.keys(r.json().card).slice(0, 3)).toEqual(["title", "context", "question"]);
    const d = find("vendor-contract-q3")!;
    expect(d).toMatchObject({ context: raiseJson.context, card_ref: merge.card_ref, what_happens_after: merge.what_happens_after, options: merge.options });
    expect(d.title).toBe("Q3 vendor contract renewal");
    expect(d.blocking).toBe(false);
    expect(d).not.toHaveProperty("priority");
    expect(d).not.toHaveProperty("blocks");
    expect(Object.keys(d).slice(0, 2)).toEqual(["id", "title"]);
    expect(d.answer).toBeUndefined();
    expect(Date.parse(d.created_at)).not.toBeNaN();
    expect(d.updated_at).toBe(d.created_at);
    expect(needsYou(read().decisions, {}).map((x) => x.id)).toEqual(["vendor-contract-q3"]);
    const s = readFileSync(file, "utf8");
    expect(s.startsWith('import type { Board } from "./types";')).toBe(true);
    expect(s.trimEnd().endsWith(`${Z}\n;`)).toBe(true);
    expect(readFileSync(abLog, "utf8")).toMatch(/"op":"raise","id":"vendor-contract-q3"/);

    // Raising an open id again replaces it and keeps created_at.
    expect(run(raiseWith({ ...raiseJson, title: "Q3 vendor contract timing", question: "Approve the Q3 vendor contract today?" })).status).toBe(0);
    expect(find("vendor-contract-q3")).toMatchObject({ title: "Q3 vendor contract timing", question: "Approve the Q3 vendor contract today?", created_at: d.created_at });
    expect(Date.parse(find("vendor-contract-q3")!.updated_at!)).toBeGreaterThan(Date.parse(d.created_at));
    expect(read().decisions).toHaveLength(1);
  });

  it("raise: link is stored and stands in for a missing card_ref, and the JSON can come from stdin", () => {
    const { card_ref: _, ...rest } = raiseJson;
    writeFileSync(join(repo, "d.json"), JSON.stringify({ ...rest, id: "from-stdin", link: "https://example.com/pr/1", multiSelect: true }));
    const r = run(`${AB} raise < d.json`);
    expect(r.status).toBe(0);
    expect(r.json().card).toMatchObject({ link: "https://example.com/pr/1", multiSelect: true });
    expect(find("from-stdin")).toMatchObject({ card_ref: "https://example.com/pr/1", link: "https://example.com/pr/1", multiSelect: true });
  });

  it("lint-card: validates stdin as documented without a board file", () => {
    writeFileSync(join(repo, "decision.json"), JSON.stringify(raiseJson));
    const missing = join(appDir, "src/data/missing-board.ts");
    const r = run(lintCardCmd, { AB_FILE: missing });
    expect([r.status, r.json()]).toEqual([0, { ok: true }]);
    expect(existsSync(missing)).toBe(false);
  });

  it("raise: refuses bad input with exit 2", () => {
    const { title: _, ...noTitle } = raiseJson;
    const opts = raiseJson.options;
    const bad: [object, RegExp][] = [
      [noTitle, /title is required/],
      [{ ...raiseJson, title: "  " }, /title is required/],
      [{ ...raiseJson, answer: { answer: "approve" } }, /unknown field answer/],
      [{ ...raiseJson, updated_at: "2026-11-10T09:00:00.000Z" }, /unknown field updated_at/],
      [{ ...raiseJson, id: "Merge_11461" }, /id must be lowercase-kebab/],
      [{ ...raiseJson, id: "ab" }, /id must be lowercase-kebab/],
      [{ ...raiseJson, question: "" }, /need question and what_happens_after/],
      [{ ...raiseJson, options: [] }, /need at least one option/],
      [{ ...raiseJson, options: [opts[0], opts[0]] }, /options need unique id\+label/],
      [{ ...raiseJson, options: [{ id: "custom", label: "Other" }] }, /'custom' is reserved/],
      [{ ...raiseJson, options: [{ id: "x" }] }, /options need unique id\+label/],
      [{ ...raiseJson, multiSelect: "yes" }, /multiSelect must be true or false/],
      [{ ...raiseJson, allowCustom: 0 }, /allowCustom must be true or false/],
      [{ ...raiseJson, context: undefined }, /^ab: context is required/],
      [{ ...raiseJson, context: "ACME-123 #101", link: "https://github.com/acme/example-api/pull/101", card_ref: "https://linear.app/acme/issue/ACME-123" }, /^ab: context needs at least 6 plain words/],
      [{ ...raiseJson, question: "Should the PR be merged now?" }, /^ab: question: "the PR" is vague\. Name the thing in plain words/],
      [{ ...raiseJson, question: "Merge it now?" }, /^ab: question: "it" is vague/],
      [{ ...raiseJson, title: "Merge #101?", link: "https://github.com/acme/example-api/pull/101" }, /^ab: title: "Merge #101\?" is only an id\. Add plain words/],
      [{ ...raiseJson, title: "a".repeat(61) }, /^ab: title is 61 chars; keep it to 60 or fewer/],
      [{ ...raiseJson, title: "Q3 vendor\ncontract renewal" }, /^ab: title must be one line/],
      [{ ...raiseJson, title: 11461 }, /^ab: title is required/],
      [{ ...raiseJson, blocking: undefined }, /^ab: blocking is required: true only if a named open PR, merge or task cannot move until this is answered, and then blocks names it; else false$/m],
      [{ ...raiseJson, blocking: "yes" }, /^ab: blocking is required/],
      [{ ...raiseJson, blocking: true, blocks: "Signing the Q3 hosting contract", priority: "medium" }, /^ab: blocking cards are always high priority/],
      [{ ...raiseJson, blocking: true, blocks: "Signing the Q3 hosting contract", priority: "low" }, /^ab: blocking cards are always high priority/],
      [{ ...raiseJson, blocking: true }, /^ab: blocking:true needs "blocks" \(1 to 200 chars\) naming the work it blocks: a card is blocking only when a named piece of in-flight work \(a specific open PR, merge or task being actively driven\) cannot move until the user answers$/m],
      [{ ...raiseJson, blocking: true, blocks: "" }, /^ab: blocking:true needs "blocks"/],
      [{ ...raiseJson, blocking: true, blocks: "   " }, /^ab: blocking:true needs "blocks"/],
      [{ ...raiseJson, blocking: true, blocks: "x".repeat(201) }, /^ab: blocking:true needs "blocks" \(1 to 200 chars\)/],
      [{ ...raiseJson, blocks: "Signing the Q3 hosting contract" }, /^ab: blocks is only for blocking:true cards: a card is blocking only when/],
    ];
    for (const [d, msg] of bad) refused(raiseWith(d), 2, msg);
    expect(read().decisions).toEqual([]);
  });

  it("raise: blocks is stored trimmed and listed in open; a re-raise with blocking:false drops it", () => {
    const card = run(raiseWith({ ...raiseJson, blocking: true, blocks: "  Signing the Q3 hosting contract  " })).json().card;
    expect(card).toMatchObject({ priority: "high", blocking: true, blocks: "Signing the Q3 hosting contract" });
    expect(find("vendor-contract-q3")!.blocks).toBe("Signing the Q3 hosting contract");
    expect(run(openCmd).json().open_priority).toEqual([{ id: "vendor-contract-q3", priority: "high", blocking: true, blocks: "Signing the Q3 hosting contract" }]);
    expect(run(raiseCmd).json().card).toMatchObject({ blocking: false, blocks: null });
    expect(find("vendor-contract-q3")).not.toHaveProperty("blocks");
    expect(find("vendor-contract-q3")!.blocking).toBe(false);
    expect(run(openCmd).json().open_priority).toEqual([{ id: "vendor-contract-q3", priority: "high", blocking: false, blocks: null }]);
  });

  it("check and lint: flag an open blocking card without blocks; check flags more than AB_MAX_HIGH open high cards", () => {
    const answered = { ...merge, id: "answered-1", blocking: true, priority: "high", answer: { answer: "approve", answer_label: "Approve", answered_by: "chat", answered_at: "2026-11-10T09:05:00.000Z" } } as Decision;
    seed([{ ...merge, blocking: true, priority: "high" }, { ...notify, blocking: true, priority: "high", blocks: " " }, answered]);
    const check = run(checkCmd);
    expect(check.status).toBe(1);
    expect(check.json().problems).toEqual([
      "blocking is true but blocks is empty: name the in-flight work it holds up, or raise vendor-contract-q3 again with blocking:false",
      "blocking is true but blocks is empty: name the in-flight work it holds up, or raise offsite-venue-quotes again with blocking:false",
    ]);
    const lint = run(lintCmd);
    expect(lint.status).toBe(1);
    expect(lint.json().failing).toEqual([
      { id: "vendor-contract-q3", problems: [expect.stringMatching(/^blocking is true but blocks is empty/)] },
      { id: "offsite-venue-quotes", problems: [expect.stringMatching(/^blocking is true but blocks is empty/)] },
    ]);

    const highs = (n: number) => [...Array(n)].map((_, i) => ({ ...merge, id: `high-${i + 1}`, priority: "high" }) as Decision);
    seed([...highs(10), { ...notify, priority: "low" }, answered]);
    expect(run(`${AB} check`).status).toBe(0);
    seed([...highs(11), answered]);
    const flood = run(`${AB} check`);
    expect(flood.status).toBe(1);
    expect(flood.json().problems).toEqual(["11 open cards are high (limit 10): a flood of high cards hides the real blockers"]);
    expect(run(lintCmd).status).toBe(0);
    expect(run(`${AB} check`, { AB_MAX_HIGH: "20" }).status).toBe(0);
    refused(`AB_MAX_HIGH=0 ${AB} check`, 2, /^ab: AB_MAX_HIGH must be a positive integer$/m);
  });

  it("answer: one option, as written; a retry is a no-op and an answered decision cannot be raised again", () => {
    seed([merge]);
    const r = run(answerCmd);
    expect(r.status).toBe(0);
    expect(r.json()).toMatchObject({ ok: true, status: "answered", live: true });
    const answer = find("vendor-contract-q3")!.answer;
    expect(answer).toStrictEqual({ answer: "approve", answer_label: "Approve", answered_by: "chat", answered_at: expect.any(String) });
    expect(Date.parse(answer!.answered_at)).not.toBeNaN();
    expect(find("vendor-contract-q3")).toMatchObject({ created_at: merge.created_at, updated_at: expect.any(String) });
    expect(Date.parse(find("vendor-contract-q3")!.updated_at!)).toBeGreaterThan(Date.parse(merge.created_at));
    expect(needsYou(read().decisions, {})).toEqual([]);

    const again = run(`${AB} answer vendor-contract-q3 hold --by app`);
    expect(again.status).toBe(0);
    expect(again.json()).toMatchObject({ status: "already-answered", answer: { answer: "approve" } });
    expect(find("vendor-contract-q3")!.answer).toStrictEqual(answer);
    refused(raiseCmd, 4, /vendor-contract-q3 is already answered/);
  });

  it("answer: several options on a multi-select decision, as written, stored in option order", () => {
    seed([notify, { ...notify, id: "notify-2" }, { ...notify, id: "notify-3" }]);
    expect(run(answerMultiCmd).status).toBe(0);
    expect(find("offsite-venue-quotes")!.answer).toStrictEqual({
      answer: ["lakeside", "farm"],
      answer_label: ["Lakeside lodge", "Farm retreat"],
      answered_by: "app",
      answered_at: "2026-11-10T09:05:00.000Z",
    });
    expect(run(`${AB} answer notify-2 farm,lakeside --by chat`).status).toBe(0);
    expect(find("notify-2")!.answer).toMatchObject({ answer: ["lakeside", "farm"], answer_label: ["Lakeside lodge", "Farm retreat"] });
    expect(run(`${AB} answer notify-3 downtown --by chat`).status).toBe(0);
    expect(find("notify-3")!.answer).toMatchObject({ answer: ["downtown"], answer_label: ["Downtown loft"] });
  });

  it("answer: free text, as written, and trimmed", () => {
    seed([merge, { ...merge, id: "custom-2" }]);
    expect(run(answerCustomCmd).status).toBe(0);
    expect(find("vendor-contract-q3")!.answer).toStrictEqual({
      answer: "custom",
      answer_label: "Approve if the term drops to 6 months",
      answered_by: "chat",
      answered_at: expect.any(String),
      custom_text: "Approve if the term drops to 6 months",
    });
    expect(run(`${AB} answer custom-2 --custom "  Ask finance first  " --by app --at 2026-11-10T11:00:00.000Z`).status).toBe(0);
    expect(find("custom-2")!.answer).toStrictEqual({
      answer: "custom",
      answer_label: "Ask finance first",
      answered_by: "app",
      answered_at: "2026-11-10T11:00:00.000Z",
      custom_text: "Ask finance first",
    });
  });

  it("answer: refuses bad input with exit 2 and an unknown decision with exit 5", () => {
    seed([merge, notify]);
    refused(`${AB} answer vendor-contract-q3 approve,hold --by chat`, 2, /vendor-contract-q3 is single-select/);
    refused(`${AB} answer vendor-contract-q3 nope --by chat`, 2, /unknown option nope/);
    refused(`${AB} answer offsite-venue-quotes lakeside,nope --by chat`, 2, /unknown option nope/);
    refused(`${AB} answer vendor-contract-q3 , --by chat`, 2, /need an option id/);
    refused(`${AB} answer vendor-contract-q3 --by chat`, 2, /need an option id/);
    refused(`${AB} answer vendor-contract-q3 approve`, 2, /usage: ab answer/);
    refused(`${AB} answer vendor-contract-q3 approve --by someone`, 2, /usage: ab answer/);
    refused(`${AB} answer vendor-contract-q3 --custom "   " --by chat`, 2, /blank custom text/);
    refused(`${AB} answer missing merge --by chat`, 5, /no decision missing/);
    expect(needsYou(read().decisions, {}).map((x) => x.id)).toEqual(["vendor-contract-q3", "offsite-venue-quotes"]);
    seed([{ ...merge, allowCustom: false }]);
    refused(`${AB} answer vendor-contract-q3 --custom "Ask finance first" --by chat`, 2, /vendor-contract-q3 does not allow a custom answer/);
    expect(find("vendor-contract-q3")!.answer).toBeUndefined();
  });

  it("clear: removes the decision as written and refuses to raise its id again", () => {
    seed([merge]);
    const r = run(clearCmd);
    expect(r.status).toBe(0);
    expect(r.json()).toEqual({ ok: true, status: "cleared", id: "vendor-contract-q3" });
    expect(find("vendor-contract-q3")).toBeUndefined();
    const tomb = JSON.parse(readFileSync(cleared, "utf8").trim());
    expect(Object.keys(tomb)).toEqual(["id", "reason", "at", "card"]);
    expect(tomb).toMatchObject({ id: "vendor-contract-q3", reason: "Signed in the vendor portal" });
    expect(tomb.card).toStrictEqual(merge);
    refused(clearCmd, 5, /no decision vendor-contract-q3/);
    refused(raiseCmd, 4, /vendor-contract-q3 was cleared before/);
    seed([merge]);
    refused(`${AB} clear vendor-contract-q3`, 2, /usage: ab clear/);
    expect(existsSync(cleared)).toBe(false);
  });

  it("restore: brings the cleared card back as written; raise works on the id again; refusals leave the board alone", () => {
    seed([{ ...merge, priority: "high", updated_at: "2026-11-10T08:30:00.000Z" }, notify]);
    const before = read().decisions;
    expect(run(clearCmd).status).toBe(0);
    const r = run(restoreCmd);
    expect(r.status).toBe(0);
    expect(r.json()).toEqual({ ok: true, status: "restored", id: "vendor-contract-q3" });
    // Back at the end, identical to what was cleared.
    expect(read().decisions).toStrictEqual([before[1], before[0]]);
    const lines = readFileSync(cleared, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => Object.keys(l))).toEqual([["id", "reason", "at", "card"], ["id", "restored", "at"]]);
    expect(readFileSync(abLog, "utf8")).toMatch(/"op":"restore","id":"vendor-contract-q3"\}/);
    refused(restoreCmd, 4, /vendor-contract-q3 is already on the board/);
    refused(`${AB} restore notify-9999`, 5, /nothing to restore for notify-9999/);
    refused(`${AB} restore`, 2, /usage: ab restore/);
    expect(run(raiseCmd).status).toBe(0);
    // A tombstone from before cards were kept cannot be restored, and raise still refuses that id.
    seed([]);
    writeFileSync(cleared, JSON.stringify({ id: "vendor-contract-q3", reason: "old", at: "2026-11-01T00:00:00.000Z" }) + "\n");
    refused(restoreCmd, 4, /vendor-contract-q3 was cleared without a saved card; it cannot be restored/);
    refused(raiseCmd, 4, /vendor-contract-q3 was cleared before/);
  });

  it("priority: sets only that card's priority as written; check counts it; refusals leave the board alone", () => {
    seed([merge, notify]);
    const before = read();
    const r = run(priorityCmd);
    expect(r.status).toBe(0);
    expect(r.json()).toEqual({ ok: true, id: "vendor-contract-q3", priority: "high", was: "medium", live: true });
    const after = read();
    expect(after.decisions).toStrictEqual([{ ...merge, priority: "high" }, notify]);
    expect(after.glance).toStrictEqual(before.glance);
    expect(readFileSync(abLog, "utf8")).toMatch(/"op":"priority","id":"vendor-contract-q3","priority":"high"\}/);
    expect(run(`${AB} check`).json()).toMatchObject({
      priority_open: { high: 1, medium: 1, low: 0 },
      open_priority: [
        { id: "vendor-contract-q3", priority: "high", blocking: null, blocks: null },
        { id: "offsite-venue-quotes", priority: "medium", blocking: null, blocks: null },
      ],
    });
    // raise's priority shows on the printed card; a re-raise without it keeps the stored one.
    expect(run(raiseCmd).json().card.priority).toBe("high");
    expect(find("vendor-contract-q3")!.priority).toBe("high");
    refused(raiseWith({ ...raiseJson, priority: "urgent" }), 2, /priority must be high, medium or low/);
    // A blocking card stays high: raising it with blocking:true keeps it high, and ab priority refuses a lower level.
    expect(run(raiseWith({ ...raiseJson, blocking: true, blocks: "Signing the Q3 hosting contract" })).json().card).toMatchObject({ priority: "high", blocking: true });
    refused(`${AB} priority vendor-contract-q3 low`, 2, /vendor-contract-q3 is a blocking card; blocking cards stay high/);
    refused(`${AB} priority vendor-contract-q3 urgent`, 2, /usage: ab priority <id> <high\|medium\|low>/);
    refused(`${AB} priority vendor-contract-q3`, 2, /usage: ab priority/);
    refused(`${AB} priority nope-1 low`, 5, /no decision nope-1 on the board/);
    expect(run(`${AB} answer vendor-contract-q3 approve --by chat`).status).toBe(0);
    refused(`${AB} priority vendor-contract-q3 low`, 4, /vendor-contract-q3 is already answered/);
  });

  it("glance: replaces the glance from stdin, as written", () => {
    const glance = { waiting: [{ title: "W", who: "Someone" }], tickets: [{ id: "PROJ-1", title: "T", status: "To Do" }] };
    writeFileSync(join(repo, "glance.json"), JSON.stringify(glance));
    const r = run(glanceCmd);
    expect(r.status).toBe(0);
    // A missing others list is written as [].
    expect(r.json()).toEqual({ ok: true, live: true, counts: { waiting: 1, tickets: 1, others: 0 } });
    expect(read().glance).toStrictEqual({ ...glance, others: [] });

    // A legacy empty parked list is accepted and dropped from the file.
    writeFileSync(join(repo, "glance.json"), JSON.stringify({ ...glance, parked: [] }));
    expect(run(glanceCmd).json()).toEqual({ ok: true, live: true, counts: { waiting: 1, tickets: 1, others: 0 } });
    expect(read().glance).toStrictEqual({ ...glance, others: [] });

    const others = [{ title: "Tax tiers", author: "Sam", who: "Your review requested", link: "https://github.com/o/r/pull/1" }];
    writeFileSync(join(repo, "glance.json"), JSON.stringify({ ...glance, others }));
    expect(run(glanceCmd).json()).toEqual({ ok: true, live: true, counts: { waiting: 1, tickets: 1, others: 1 } });
    expect(read().glance).toStrictEqual({ ...glance, others });

    writeFileSync(join(repo, "glance.json"), JSON.stringify({ ...glance, waiting: {} }));
    refused(glanceCmd, 2, /glance.waiting must be an array/);
  });

  it("glance: refuses a bad others list or item, board unchanged", () => {
    const glance = { waiting: [], tickets: [] };
    const ok = { title: "T", author: "A", who: "W", link: "https://example.com/1" };
    const cases: [unknown, RegExp][] = [
      [{}, /glance\.others must be an array/],
      [[{ ...ok, author: undefined }], /glance\.others\[0\]\.author must be a non-blank string/],
      [[ok, { ...ok, who: " " }], /glance\.others\[1\]\.who must be a non-blank string/],
      [[{ ...ok, status: "Open" }], /glance\.others\[0\] has unknown key status/],
      [[{ ...ok, link: "github.com/o/r/pull/1" }], /glance\.others\[0\]\.link must start with http:\/\/ or https:\/\//],
      [["PR"], /glance\.others\[0\] must be an object/],
    ];
    for (const [others, msg] of cases) {
      writeFileSync(join(repo, "glance.json"), JSON.stringify({ ...glance, others }));
      refused(glanceCmd, 2, msg);
    }
  });

  it("glance: refuses a non-empty parked list; those are decisions now", () => {
    const glance = { waiting: [], tickets: [] };
    writeFileSync(join(repo, "glance.json"), JSON.stringify({ ...glance, parked: [{ title: "Whether to reply to the vendor" }] }));
    refused(glanceCmd, 2, /glance\.parked is retired: raise those as decisions with "ab raise" instead/);
    writeFileSync(join(repo, "glance.json"), JSON.stringify({ ...glance, parked: {} }));
    refused(glanceCmd, 2, /glance\.parked must be an array/);
  });

  it("glance: accepts base, head and hot on PR items, keeps hot markers across a refresh, an explicit hot wins", () => {
    const pr = { title: "Analytics for The dashboard", who: "Bob's re-review", link: "https://github.com/acme/example-api/pull/11764", base: "project", head: "PROJ-1-analytics" };
    const other = { title: "Tax tiers", author: "Bob", who: "Your review requested", link: "https://github.com/o/r/pull/1", base: "main", head: "hotfix/tax", hot: true };
    const glance = (g: object) => writeFileSync(join(repo, "glance.json"), JSON.stringify({ tickets: [], ...g }));
    glance({ waiting: [pr], others: [other] });
    expect(run(glanceCmd).json()).toEqual({ ok: true, live: true, counts: { waiting: 1, tickets: 0, others: 1 } });
    expect(read().glance).toStrictEqual({ waiting: [pr], tickets: [], others: [other] });

    // A routine refresh without hot keys keeps the marker on the same link, and only there.
    const { hot: _, ...plain } = other;
    glance({ waiting: [pr], others: [plain, { ...plain, link: "https://github.com/o/r/pull/2" }] });
    expect(run(glanceCmd).status).toBe(0);
    expect(read().glance.others).toStrictEqual([other, { ...plain, link: "https://github.com/o/r/pull/2" }]);
    expect(read().glance.waiting).toStrictEqual([pr]);
    // The marker follows the link across lists too.
    glance({ waiting: [{ ...pr, link: other.link }], others: [] });
    expect(run(glanceCmd).status).toBe(0);
    expect(read().glance.waiting).toStrictEqual([{ ...pr, link: other.link, hot: true }]);
    // An explicit hot:false wins.
    glance({ waiting: [{ ...pr, link: other.link, hot: false }], others: [] });
    expect(run(glanceCmd).status).toBe(0);
    expect(read().glance.waiting).toStrictEqual([{ ...pr, link: other.link, hot: false }]);

    const cases: [object, RegExp][] = [
      [{ waiting: [{ ...pr, base: " " }], others: [] }, /glance\.waiting\[0\]\.base must be a non-blank string \(a branch name\)/],
      [{ waiting: [], others: [{ ...other, head: 3 }] }, /glance\.others\[0\]\.head must be a non-blank string/],
      [{ waiting: [], others: [{ ...other, hot: "yes" }] }, /glance\.others\[0\]\.hot must be true or false/],
      [{ waiting: [pr, { ...pr, hot: 1 }], others: [] }, /glance\.waiting\[1\]\.hot must be true or false/],
    ];
    for (const [g, msg] of cases) {
      glance(g);
      refused(glanceCmd, 2, msg);
    }
  });

  it("hot and unhot: as written, record the mark in the hot map and on the glance PRs with that link, log real changes", () => {
    const link = "https://github.com/acme/example-api/pull/11764";
    const mine = { title: "Analytics for The dashboard", who: "Bob's re-review", link };
    const theirs = { title: "Tax tiers", author: "Bob", who: "Your review requested", link, base: "project" };
    const lone = { ...theirs, link: "https://github.com/acme/example-web/pull/7" };
    const b = read();
    writeFileSync(file, original.slice(0, original.indexOf(A) + A.length) + "\n" + JSON.stringify({ ...b, glance: { waiting: [mine], tickets: [], others: [theirs, lone] } }, null, 2) + "\n" + original.slice(original.indexOf(Z)));
    const events = () => (existsSync(eventsFile) ? readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

    expect(hotCmd).toBe(`${AB} hot ${link}`);
    const r = run(hotCmd);
    expect(r.status).toBe(0);
    const mark = { hot: true, by: "cli", at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) };
    const stamp = { hot_by: "cli", hot_at: r.json().mark.at };
    expect(r.json()).toEqual({ ok: true, live: true, section: "waiting", item: { ...mine, hot: true, ...stamp }, mark, status: "changed" });
    expect(read().hot).toEqual({ [link]: mark });
    // Every glance PR with that link gets it; the reply names the first (waiting first).
    expect(read().glance).toStrictEqual({ waiting: [{ ...mine, hot: true, ...stamp }], tickets: [], others: [{ ...theirs, hot: true, ...stamp }, lone] });
    expect(read().updated_at).not.toBe(b.updated_at);
    expect(readFileSync(abLog, "utf8")).toMatch(/"op":"hot","link":"https:\/\/github\.com\/acme\/example-api\/pull\/11764","section":"waiting","live":true\}/);
    expect(events()).toEqual([{ at: stamp.hot_at, kind: "hot", url: link, by: "cli" }]);
    // Again: already hot, nothing written or logged.
    const before = readFileSync(file, "utf8");
    expect(run(hotCmd).json()).toMatchObject({ ok: true, status: "unchanged", mark: { hot: true, by: "cli", at: stamp.hot_at } });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(events()).toHaveLength(1);

    expect(run(`${AB} hot ${lone.link} --by assistant`).json()).toMatchObject({ section: "others", item: { ...lone, hot: true, hot_by: "assistant" }, status: "changed" });

    expect(unhotCmd).toBe(`${AB} unhot ${link}`);
    const u = run(unhotCmd).json();
    expect(u).toEqual({ ok: true, live: true, section: "waiting", item: { ...mine, hot_by: "cli", hot_at: u.mark.at }, mark: { ...mark, hot: false }, status: "changed" });
    expect(read().glance.waiting).toStrictEqual([{ ...mine, hot_by: "cli", hot_at: u.mark.at }]);
    expect(read().hot?.[link]).toEqual({ hot: false, by: "cli", at: u.mark.at });
    expect(run(unhotCmd).json()).toMatchObject({ status: "unchanged" });
    expect(events().map((e) => [e.kind, e.url, e.by])).toEqual([["hot", link, "cli"], ["hot", lone.link, "assistant"], ["unhot", link, "cli"]]);

    // A PR in no glance list: only the hot map entry (the PRs tab flame on a feed row with no board card).
    const glanceBefore = read().glance;
    const feedOnly = "https://github.com/acme/example-api/pull/404";
    expect(run(`${AB} hot ${feedOnly}/`).json()).toEqual({ ok: true, live: true, section: null, item: null, mark, status: "changed" });
    expect(read().hot?.[feedOnly]).toMatchObject({ hot: true, by: "cli" });
    expect(read().glance).toStrictEqual(glanceBefore);

    refused(`${AB} hot https://github.com/bad_owner/example-api/pull/404`, 2, /the owner is missing or invalid/);
    refused(`${AB} unhot ${link}/files`, 2, /nothing may follow the PR number/);
    refused(`${AB} hot ${link} --by "assistant bot"`, 2, /^ab: hot: --by must be 1 to 32 letters, digits, _ or -/);
    refused(`${AB} hot`, 2, /^ab: usage: ab hot <pr-url> \[--by name\]/);
    refused(`${AB} hot pull/11764`, 2, /usage: ab hot <pr-url>/);
    refused(`${AB} unhot ${link} ${lone.link}`, 2, /usage: ab unhot <pr-url>/);
    expect(events()).toHaveLength(4);
  });

  it("open and check: as written, and check exits 1 when chat and board disagree", () => {
    seed([merge, notify]);
    const open = run(openCmd);
    expect(open.status).toBe(0);
    expect(open.json()).toEqual({
      ok: true,
      open_on_board: ["vendor-contract-q3", "offsite-venue-quotes"],
      served_open: null,
      counts: { waiting: glance0.waiting.length, tickets: glance0.tickets.length, others: glance0.others?.length ?? 0 },
      priority_open: { high: 0, medium: 2, low: 0 },
      open_priority: [
        { id: "vendor-contract-q3", priority: "medium", blocking: null, blocks: null },
        { id: "offsite-venue-quotes", priority: "medium", blocking: null, blocks: null },
      ],
      problems: [],
    });

    const check = run(checkCmd);
    expect(check.status).toBe(0);
    expect(check.json()).toMatchObject({ ok: true, problems: [] });

    const boardOnly = run(`${AB} check --chat vendor-contract-q3`);
    expect(boardOnly.status).toBe(1);
    expect(boardOnly.json().problems).toEqual([expect.stringContaining("board decision offsite-venue-quotes has no open chat card")]);
    expect(run(`${AB} open --chat vendor-contract-q3`).status).toBe(0);

    const chatOnly = run(`${AB} check --chat vendor-contract-q3,offsite-venue-quotes,ghost-1`);
    expect(chatOnly.status).toBe(1);
    expect(chatOnly.json().problems).toEqual([expect.stringContaining("chat card ghost-1 is NOT on the board")]);

    expect(run(answerCmd).status).toBe(0);
    const answered = run(checkCmd);
    expect(answered.status).toBe(1);
    expect(answered.json().problems).toEqual([expect.stringContaining("chat card vendor-contract-q3 is answered on the board")]);
  });

  it("open, check and raise neither need a parked key nor touch a legacy empty one", () => {
    const legacy = { waiting: [], parked: [], tickets: [] };
    const b: Board = { updated_at: "2026-11-10T08:00:00.000Z", decisions: [merge, notify], glance: legacy };
    writeFileSync(file, original.slice(0, original.indexOf(A) + A.length) + "\n" + JSON.stringify(b, null, 2) + "\n" + original.slice(original.indexOf(Z)));
    expect(run(checkCmd).status).toBe(0);
    expect(run(raiseWith({ ...raiseJson, id: "legacy-1" })).status).toBe(0);
    expect(read().glance).toStrictEqual(legacy);

    const { parked: _, ...noParked } = legacy;
    writeFileSync(file, original.slice(0, original.indexOf(A) + A.length) + "\n" + JSON.stringify({ ...b, glance: noParked }, null, 2) + "\n" + original.slice(original.indexOf(Z)));
    expect(run(openCmd).status).toBe(0);
    expect(run(checkCmd).status).toBe(0);
    expect(read().glance).toStrictEqual(noParked);
  });

  it("check: reports glance counts, others 0 when the file has no others", () => {
    const b: Board = { updated_at: "2026-11-10T08:00:00.000Z", decisions: [merge], glance: { waiting: [], tickets: [] } };
    writeFileSync(file, original.slice(0, original.indexOf(A) + A.length) + "\n" + JSON.stringify(b, null, 2) + "\n" + original.slice(original.indexOf(Z)));
    const check = run(`${AB} check --chat vendor-contract-q3`);
    expect(check.status).toBe(0);
    expect(check.json().counts).toEqual({ waiting: 0, tickets: 0, others: 0 });

    const others = [{ title: "Tax tiers", author: "Sam", who: "Waiting on Sam", link: "https://github.com/o/r/pull/1" }];
    writeFileSync(file, original.slice(0, original.indexOf(A) + A.length) + "\n" + JSON.stringify({ ...b, glance: { ...b.glance, others } }, null, 2) + "\n" + original.slice(original.indexOf(Z)));
    expect(run(`${AB} check --chat vendor-contract-q3`).json().counts).toEqual({ waiting: 0, tickets: 0, others: 1 });
  });

  it("lint: as written, flags open cards without context or with a vague question", () => {
    seed([merge, notify]);
    expect(run(lintCmd).status).toBe(0);
    expect(run(lintCmd).json()).toEqual({ ok: true, failing: [] });

    const { context: _, ...noContext } = notify;
    const answered = { ...merge, id: "answered-1", question: "Ship it?", answer: { answer: "approve", answer_label: "Approve", answered_by: "chat", answered_at: "2026-11-10T09:05:00.000Z" } } as Decision;
    seed([merge, noContext, { ...merge, id: "vague-1", question: "What should happen to the ticket?" }, answered]);
    const before = readFileSync(file, "utf8");
    const r = run(lintCmd);
    expect(r.status).toBe(1);
    expect(r.json()).toEqual({
      ok: false,
      failing: [
        { id: "offsite-venue-quotes", problems: [expect.stringMatching(/^context is required/)] },
        { id: "vague-1", problems: [expect.stringMatching(/^question: "the ticket" is vague/)] },
      ],
    });
    expect(readFileSync(file, "utf8")).toBe(before);

    const { title: _t, ...noTitle } = merge;
    seed([noTitle as Decision]);
    const t = run(lintCmd);
    expect(t.status).toBe(1);
    expect(t.json().failing).toEqual([{ id: "vendor-contract-q3", problems: [expect.stringMatching(/^title is required/)] }]);
  });

  it("backfill-titles: as written, titles open cards without one; an invalid title writes nothing", () => {
    const { title: _m, ...mergeNoTitle } = merge;
    const { title: _n, ...notifyNoTitle } = notify;
    const answered = { ...mergeNoTitle, id: "answered-1", answer: { answer: "approve", answer_label: "Approve", answered_by: "chat", answered_at: "2026-11-10T09:05:00.000Z" } };
    const stamped = { ...mergeNoTitle, updated_at: "2026-11-10T08:30:00.000Z" };
    seed([stamped, notifyNoTitle, answered, { ...merge, id: "has-title" }] as Decision[]);
    const titles = (m: object) => writeFileSync(join(repo, "titles.json"), JSON.stringify(m));

    titles({ "vendor-contract-q3": "Q3 vendor contract renewal date", "offsite-venue-quotes": "PROJ-1" });
    refused(backfillTitlesCmd, 2, /^ab: offsite-venue-quotes: title: "PROJ-1" is only an id/);

    titles({ "vendor-contract-q3": " Q3 vendor contract renewal date ", "answered-1": "Answered card title", "has-title": "Other title words", "gone-1": "Unknown card title" });
    const r = run(backfillTitlesCmd);
    expect(r.status).toBe(0);
    expect(r.json()).toEqual({
      ok: true,
      wrote: true,
      set: ["vendor-contract-q3"],
      unknown: ["gone-1"],
      skipped_answered: ["answered-1"],
      skipped_has_title: ["has-title"],
      still_missing: ["offsite-venue-quotes"],
    });
    const d = find("vendor-contract-q3")!;
    expect(d).toStrictEqual({ ...stamped, title: "Q3 vendor contract renewal date" });
    expect(Object.keys(d).slice(0, 2)).toEqual(["id", "title"]);
    expect(find("has-title")!.title).toBe(merge.title);
    expect(find("answered-1")).not.toHaveProperty("title");
    expect(readFileSync(abLog, "utf8").trim().split("\n").at(-1)).toMatch(/"op":"backfill-titles","count":1\}$/);
  });

  it("backfill-stamps: as written, fills missing stamps from the log; --dry-run and a second run write nothing", () => {
    const { created_at: _, ...noCreated } = notify;
    seed([merge, noCreated as Decision]);
    const log = [
      { at: "2026-11-10T08:00:00.300Z", op: "raise", id: "vendor-contract-q3" },
      { at: "2026-11-10T08:30:00.300Z", op: "raise", id: "offsite-venue-quotes" },
      { at: "2026-11-10T09:05:00.000Z", op: "answer", id: "offsite-venue-quotes" },
    ];
    writeFileSync(abLog, log.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const before = readFileSync(file, "utf8");
    const dry = run(`${backfillCmd} --dry-run`);
    expect(dry.status).toBe(0);
    expect(dry.json()).toMatchObject({ ok: true, dry_run: true, wrote: false, stamped: ["vendor-contract-q3", "offsite-venue-quotes"] });
    expect(readFileSync(file, "utf8")).toBe(before);

    const r = run(backfillCmd);
    expect(r.status).toBe(0);
    expect(r.json()).toEqual({
      ok: true,
      dry_run: false,
      wrote: true,
      stamped: ["vendor-contract-q3", "offsite-venue-quotes"],
      blank: [],
      no_history: [],
      unchanged: 0,
      counts: { stamped: 2, blank: 0, no_history: 0, unchanged: 0, total: 2 },
    });
    expect(find("vendor-contract-q3")).toStrictEqual({ ...merge, updated_at: merge.created_at });
    expect(find("offsite-venue-quotes")).toStrictEqual({ ...noCreated, created_at: "2026-11-10T08:30:00.300Z", updated_at: "2026-11-10T09:05:00.000Z" });
    expect(readFileSync(abLog, "utf8").trim().split("\n").at(-1)).toMatch(/"op":"backfill-stamps","count":2\}$/);

    const after = readFileSync(file, "utf8");
    expect(run(backfillCmd).json()).toMatchObject({ wrote: false, stamped: [], unchanged: 2 });
    expect(readFileSync(file, "utf8")).toBe(after);
  });

  it("project-refresh: rewrites the temp project.ts with the seed counts, byte for byte", () => {
    const PA = "/* PROJECT-JSON-START */";
    const real = readFileSync(join(ROOT, "app/src/data/project.ts"), "utf8");
    writeFileSync(projectFile, real);
    expect(projectCmd.startsWith(`${AB} project-refresh '{`)).toBe(true);
    const r = run(projectCmd);
    expect(r.status).toBe(0);
    expect(r.json()).toEqual({ ok: true, milestones: 4, totals: { done: 23, in_progress: 4, left: 21, total: 44 }, updated_at: "2026-11-23T18:35:00.000Z" });
    expect(readFileSync(projectFile, "utf8")).toBe(real);
    expect(real.indexOf(PA)).toBeGreaterThan(0);
    expect(readFileSync(abLog, "utf8")).toMatch(/"op":"project-refresh","milestones":4\}/);
  });

  const readTodos = (): Todos => {
    const s = readFileSync(todosFile, "utf8");
    return JSON.parse(s.slice(s.indexOf(DA) + DA.length, s.indexOf(DZ)));
  };
  // Runs a refused todo command and checks the exit code, the message, and that todos.ts did not change.
  const refusedTodo = (cmd: string, code: number, msg: RegExp) => {
    const before = readFileSync(todosFile, "utf8");
    const r = run(cmd);
    expect([cmd, r.status]).toEqual([cmd, code]);
    expect(r.err).toMatch(msg);
    expect(readFileSync(todosFile, "utf8")).toBe(before);
  };

  it("todo-add, todo-update, todo-comment, todo-done, todo-reopen and todo-list: as written", () => {
    const boardBefore = readFileSync(file, "utf8");
    const add = run(todoAddCmd);
    expect(add.status).toBe(0);
    const t: Todo = add.json().todo;
    expect(Object.keys(add.json())).toEqual(["ok", "todo"]);
    expect(t).toEqual({ id: "call-vendor", name: "call the vendor", priority: "urgent", comments: [], created_at: expect.any(String), updated_at: t.created_at });
    expect(readTodos().items).toEqual([t]);
    expect(readTodos().updated_at).not.toBe("2026-11-26T15:00:00.000Z");
    // The wrapper outside the markers is untouched, board.ts too; the add is logged.
    const s = readFileSync(todosFile, "utf8");
    expect(s.slice(0, s.indexOf(DA))).toBe(todosSeed.slice(0, todosSeed.indexOf(DA)));
    expect(s.slice(s.indexOf(DZ))).toBe(todosSeed.slice(todosSeed.indexOf(DZ)));
    expect(readFileSync(file, "utf8")).toBe(boardBefore);
    expect(readFileSync(abLog, "utf8")).toMatch(/"op":"todo-add","id":"call-vendor"\}/);

    const upd = run(todoUpdateCmd);
    expect(upd.status).toBe(0);
    const u: Todo = upd.json().todo;
    expect(u).toEqual({ ...t, description: "Ask about the lease renewal", priority: "high", updated_at: expect.any(String) });
    expect(Object.keys(u)).toEqual(["id", "name", "description", "priority", "comments", "created_at", "updated_at"]);

    const com = run(todoCommentCmd);
    expect(com.status).toBe(0);
    expect(com.json().comment).toEqual({ id: expect.stringMatching(/^c-[0-9a-f]{8}$/), text: "Left a voicemail", author: "Assistant", at: expect.any(String) });
    expect(readTodos().items[0].comments).toEqual([com.json().comment]);
    // Without an author, a comment is by "bot".
    expect(run(`${AB} todo-comment '{"id":"call-vendor","text":"Second note"}'`).json().comment.author).toBe("bot");

    const list = run(todoListCmd);
    expect(list.status).toBe(0);
    expect(list.json()).toEqual(readTodos().items);

    const done = run(todoDoneCmd);
    expect(done.status).toBe(0);
    expect(done.json()).toMatchObject({ ok: true, status: "done", todo: { id: "call-vendor", done_at: expect.any(String) } });
    expect(Math.abs(Date.parse(done.json().todo.done_at) - Date.now())).toBeLessThan(60_000);
    expect(run(todoDoneCmd).json()).toEqual({ ...done.json(), status: "already-done" });
    expect(run(`${AB} todo-list --view done`).json().map((x: Todo) => x.id)).toEqual(["call-vendor"]);

    const reopen = run(todoReopenCmd);
    expect(reopen.status).toBe(0);
    expect(reopen.json()).toMatchObject({ ok: true, status: "reopened" });
    expect(reopen.json().todo).not.toHaveProperty("done_at");
    expect(run(todoReopenCmd).json()).toMatchObject({ status: "already-open" });
    for (const op of ["todo-update", "todo-comment", "todo-done", "todo-reopen"]) expect(readFileSync(abLog, "utf8")).toContain(`"op":"${op}","id":"call-vendor"`);
  });

  it("todo-add: subtasks one level deep; generated ids; stdin input; quick with explicit fields", () => {
    expect(run(todoAddCmd).status).toBe(0);
    const sub = run(`${AB} todo-add '{"name":"Find the lease PDF","parent_id":"call-vendor"}'`).json().todo;
    expect(sub).toMatchObject({ name: "Find the lease PDF", parent_id: "call-vendor", priority: "medium" });
    expect(sub.id).toMatch(/^find-the-lease-pdf-[0-9a-f]{6}$/);
    refusedTodo(`${AB} todo-add '{"name":"Too deep","parent_id":"${sub.id}"}'`, 2, new RegExp(`^ab: todo-add: parent_id ${sub.id} is a subtask itself; subtasks go one level deep`));
    refusedTodo(`${AB} todo-update '{"id":"call-vendor","parent_id":"${sub.id}"}'`, 2, /is a subtask itself/);

    // Completing the parent leaves the subtask open.
    expect(run(todoDoneCmd).status).toBe(0);
    expect(readTodos().items.find((x) => x.id === sub.id)).not.toHaveProperty("done_at");
    // A parent with subtasks cannot become a subtask; a cleared parent_id makes the subtask top-level.
    expect(run(`${AB} todo-add '{"id":"other-parent","name":"Other parent"}'`).status).toBe(0);
    refusedTodo(`${AB} todo-update '{"id":"call-vendor","parent_id":"other-parent"}'`, 2, /call-vendor has subtasks, so it cannot become a subtask/);
    expect(run(`${AB} todo-update '{"id":"${sub.id}","parent_id":null,"description":"In the drawer"}'`).json().todo).not.toHaveProperty("parent_id");
    expect(run(`${AB} todo-update '{"id":"${sub.id}","description":null}'`).json().todo).not.toHaveProperty("description");

    writeFileSync(join(repo, "todo.json"), JSON.stringify({ quick: "renew passport tomorrow !low", name: "Renew passport", priority: "high" }));
    const fromStdin = run(`${AB} todo-add < todo.json`).json().todo;
    expect(fromStdin).toMatchObject({ name: "Renew passport", priority: "high" });
    expect(fromStdin).not.toHaveProperty("due");
    // The legacy due field is still accepted alongside quick add.
    expect(run(`${AB} todo-add '{"quick":"tomorrow p1","name":"Call the bank","due":{"date":"2027-01-04"}}'`).json().todo).toMatchObject({ name: "Call the bank", priority: "urgent", due: { date: "2027-01-04" } });
  });

  it("todo commands: refuse bad input with exit 2 and an unknown id with exit 5, todos.ts unchanged", () => {
    expect(run(todoAddCmd).status).toBe(0);
    const cases: [string, number, RegExp][] = [
      [`${AB} todo-add '{"quick":"p1"}'`, 2, /^ab: todo-add: quick add needs a name besides the priority/],
      [`${AB} todo-add '{"description":"x"}'`, 2, /^ab: todo-add: give name or quick/],
      [`${AB} todo-add '{"name":"  "}'`, 2, /^ab: todo-add: name must be a non-blank string/],
      [`${AB} todo-add '{"name":"${"x".repeat(201)}"}'`, 2, /^ab: todo-add: name is 201 chars; keep it to 200 or fewer/],
      [`${AB} todo-add '{"name":"x","priority":"p1"}'`, 2, /^ab: todo-add: priority must be urgent, high, medium or low/],
      [`${AB} todo-add '{"name":"x","due":{"date":"2026-02-30"}}'`, 2, /^ab: todo-add: due\.date must be a real calendar date written YYYY-MM-DD/],
      [`${AB} todo-add '{"name":"x","due":{"date":"2026-12-01","time":"25:00"}}'`, 2, /^ab: todo-add: due\.time must be HH:MM/],
      [`${AB} todo-add '{"name":"x","due":{"date":"2026-12-01","tz":"UTC"}}'`, 2, /^ab: todo-add: due has unknown key tz/],
      [`${AB} todo-add '{"name":"x","due":"2026-12-01"}'`, 2, /^ab: todo-add: due must be/],
      [`${AB} todo-add '{"name":"x","color":"red"}'`, 2, /^ab: todo-add: unknown key color \(allowed: id, name, description, priority, due, parent_id, quick\)/],
      [`${AB} todo-add '{"name":"x","parent_id":"nope"}'`, 2, /^ab: todo-add: parent_id nope is not a to-do/],
      [`${AB} todo-add '{"id":"call-vendor","name":"x"}'`, 2, /^ab: todo-add: id call-vendor is already a to-do/],
      [`${AB} todo-add '{"id":"Bad Id","name":"x"}'`, 2, /^ab: todo-add: id must be lowercase kebab/],
      [`${AB} todo-add '{"name":}'`, 2, /^ab: todo-add: input is not valid JSON/],
      [`${AB} todo-add '["x"]'`, 2, /^ab: todo-add: (input must be a JSON object|usage)/],
      [`${AB} todo-update '{"id":"call-vendor"}'`, 2, /^ab: todo-update: give at least one of name, description, priority, due, parent_id/],
      [`${AB} todo-update '{"id":"call-vendor","name":null}'`, 2, /^ab: todo-update: name must be a non-blank string/],
      [`${AB} todo-update '{"id":"call-vendor","parent_id":"call-vendor"}'`, 2, /^ab: todo-update: a to-do cannot be its own parent/],
      [`${AB} todo-update '{"name":"x"}'`, 2, /^ab: todo-update: id is required/],
      [`${AB} todo-update '{"id":"nope","name":"x"}'`, 5, /^ab: todo-update: no to-do nope/],
      [`${AB} todo-comment '{"id":"call-vendor","text":"  "}'`, 2, /^ab: todo-comment: text must be a non-blank string/],
      [`${AB} todo-comment '{"id":"call-vendor","text":"${"x".repeat(4001)}"}'`, 2, /^ab: todo-comment: text is 4001 chars; keep it to 4000 or fewer/],
      [`${AB} todo-comment '{"id":"call-vendor","text":"x","author":"Assistant"}' --author Assistant`, 2, /^ab: todo-comment: give the author once/],
      [`${AB} todo-comment '{"id":"nope","text":"x"}'`, 5, /^ab: todo-comment: no to-do nope/],
      [`${AB} todo-done '{"id":"nope"}'`, 5, /^ab: todo-done: no to-do nope/],
      [`${AB} todo-done call-vendor`, 2, /^ab: todo-done: usage/],
      [`${AB} todo-reopen '{"id":"call-vendor","at":"now"}'`, 2, /^ab: todo-reopen: unknown key at/],
      [`${AB} todo-reopen '{"id":"nope"}'`, 5, /^ab: todo-reopen: no to-do nope/],
      [`${AB} todo-list --view week`, 2, /^ab: todo-list: usage: ab todo-list \[--view today\|upcoming\|done\|all\]/],
      [`${AB} todo-list extra`, 2, /^ab: todo-list: usage/],
    ];
    for (const [cmd, code, msg] of cases) refusedTodo(cmd, code, msg);
    // No temp or lock files are left behind.
    expect(readdirSync(join(appDir, "src/data")).filter((f) => !f.endsWith(".ts"))).toEqual([]);
  });

  it("todo commands refuse a todos.ts without its markers (exit 2); check flags it; a missing one is not a check problem", () => {
    writeFileSync(todosFile, "export const todos = {};\n");
    refusedTodo(todoAddCmd, 2, /^ab: todos file needs exactly one TODOS-JSON-START and one TODOS-JSON-END marker: .*todos\.ts; refusing to read or write it/);
    refusedTodo(todoListCmd, 2, /todos file needs exactly one TODOS-JSON-START/);
    const check = run(`${AB} check`);
    expect(check.status).toBe(1);
    expect(check.json().problems).toEqual([expect.stringMatching(/^todos file needs exactly one TODOS-JSON-START and one TODOS-JSON-END marker: /)]);
    expect(run(openCmd).json().problems).toEqual(check.json().problems);
    writeFileSync(todosFile, todosSeed.replace('"items": []', '"items": ['));
    expect(run(`${AB} check`).json().problems).toEqual([expect.stringMatching(/^todos file JSON does not parse/)]);
    rmSync(todosFile);
    expect(run(`${AB} check`).status).toBe(0);
    expect(run(todoDoneCmd).status).toBe(2);
    expect(run(todoDoneCmd).err).toMatch(/^ab: todos file not found: /);
  });
});
