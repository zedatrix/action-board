#!/usr/bin/env node
// ab: the ONLY supported way to raise, answer, clear, restore or check a decision on the Action Board
// (app/src/data/board.ts, served by the dev server). Run it from anywhere: paths are found from this file.
// Blocking: a card is blocking only when a named piece of in-flight work (a specific open PR, merge or task being actively
// driven) cannot move until the user answers. Rules or process questions, optional proofs, and cards older than a day or
// two are not blocking. A blocking card names that work in "blocks".
// `ab raise` writes the board, confirms the live server serves it, and only then prints
// the chat-card payload. No board write => no card text => no chat-only decision.
//
//   ab raise '<json>' | ab raise < decision.json   -> prints {"card":{...}} on success
//     Stored fields: id, title, context, question, ... ("link" is card-only: it fills card_ref).
//     The user must understand the card cold, so raise refuses (exit 2, board untouched) a card that does not say what it is about:
//     "context" (required, shown first): 1 to 3 sentences, max 600 chars, at least 6 plain words besides ids (ABC-1234, #123,
//       URLs). Say what the item is in plain words (feature or screen, not just an id) and what happened that needs the user's call.
//     "question" must name the thing. Refused: "the/this/that/these/those" + ticket|tickets|pr|prs|pull request|issue|card|bug|
//       fix|change|branch|item|one at the end, before punctuation, or before is|are|was|were|be|been|should|will|would|can|could|
//       go|get|stay|need|needs|has|have|do|does; the word "it" anywhere; "this"/"that" at the end or before punctuation.
//       "What should happen to the ticket?" and "Send it back to the vendor?" fail; "Approve the Q3 vendor contract?" passes.
//     "title" (required, stored, shown bold at the top of the card): a SHORT topic, one line, max 60 chars, at least two
//       plain words besides ids and the words pr, ticket, issue ("ABC-1234" fails; "Q3 vendor contract renewal" passes).
//       A re-raise replaces it with the new payload's title.
//     {"id":"vendor-contract-q3","title":"Q3 vendor contract renewal","context":"The hosting vendor sent the Q3 contract. It
//      renews at the same price but adds a 12 month minimum term.","question":"Approve the Q3 vendor contract?",
//      "what_happens_after":"The assistant signs and files the contract.","options":[{"id":"approve","label":"Approve"},{"id":"hold","label":"Hold"}],"blocking":false}
//     optional "details": short structure shown under the question. Each entry is a bullet string, or a
//     labeled list {"label":"...","items":["...",...],"ordered":true|false}. Keep "question" a short headline.
//     "details":["Reads CRM contacts nightly",{"label":"Defaults","items":["Sync every 24h","Read-only"]},{"label":"Tradeoffs","ordered":true,"items":["Cheaper","Slower to show changes"]}]
//     "blocking" (required, stored): true only for a blocking card (definition above), else false. Missing or not a
//     boolean: exit 2, board untouched. true forces priority "high": a passed "medium" or "low" is refused (exit 2), and a
//     re-raise with true upgrades the stored priority to high. Cards raised before this field have none (unknown).
//     "blocks" (stored trimmed): the in-flight work this card blocks, e.g. "PR #1461 hired application guard merge".
//     Required with blocking:true (non-empty after trim, max 200 chars); refused with blocking:false; else exit 2, board
//     untouched. A re-raise with blocking:false drops it. Printed on the card and in open (null when absent).
//     optional "priority": "high", "medium" or "low" (anything else: exit 2, board untouched). Left out: a new card is stored
//     without it (medium) unless blocking; a re-raise keeps the stored one. The printed card carries the effective priority
//     ("medium" if none), blocking and blocks.
//   ab answer <id> <opt[,opt]> --by chat|app [--at ISO]
//   ab answer <id> --custom "text" --by chat|app [--at ISO]
//   ab clear <id> --reason "why"                    (tombstoned: raise refuses it later) -> {"ok","status":"cleared","id"}
//                                                      the tombstone line in .ab-cleared.jsonl is {id, reason, at, card}: card is
//                                                      the removed decision as it was (lines from before this have no card).
//                                                      The app's "Not relevant anymore" control clears with --reason "not relevant".
//   ab restore <id>                                 puts the card saved by the latest clear back at the end of decisions (answer
//                                                      dropped; priority, created_at, updated_at kept) and appends {id, restored, at}
//                                                      to the tombstones, so raise accepts the id again -> {"ok","status":"restored","id"}
//                                                      nothing cleared (or already restored) exit 5; cleared without a saved card,
//                                                      or already on the board, exit 4
//   ab priority <id> <high|medium|low>              sets only that open card's priority (its updated_at stays)
//                                                      -> {"ok","id","priority","was","live"}; unknown id exit 5, answered exit 4,
//                                                      medium or low on a card stored with blocking:true exit 2 (blocking cards stay high)
//   ab open                                         -> open decision ids, file vs served, file glance counts {waiting,tickets,others},
//                                                      priority_open {high,medium,low} and open_priority [{id,priority,blocking,blocks}]
//                                                      (missing priority = medium, missing blocking/blocks = null); problems lists an open
//                                                      blocking:true card that is not high or has no blocks, and more than AB_MAX_HIGH
//                                                      (default 10) open high cards (a flood of high cards hides the real blockers)
//   ab check [--chat id1,id2]                       -> same as open; exit 1 on any mismatch or problem
//   ab glance < glance.json                         ({"waiting":[...],"tickets":[...],"others":[...]}; replaces the glance;
//                                                      others is optional (missing = []), each exactly {title,author,who,link},
//                                                      non-blank strings, link http(s)) -> {"ok","live","counts":{waiting,tickets,others}}
//   ab lint                                         -> {"ok","failing":[{"id","problems":[...]}]}: open decisions breaking
//                                                      the title/context/question rules above, or blocking:true but not high or
//                                                      without blocks; exit 1
//                                                      if any (fix with ab raise, ab priority <id> high,
//                                                      or ab backfill-titles for cards raised before titles were stored)
//   ab backfill-titles < map.json                   one-shot: {"<decision id>":"<title>"} sets the title on open cards that have
//                                                      none (same title rules; any invalid title: exit 2, nothing written;
//                                                      card stamps unchanged) -> {"ok","wrote","set","unknown","skipped_answered",
//                                                      "skipped_has_title","still_missing"}
//   ab backfill-stamps [--dry-run]                  one-shot: fill missing created_at/updated_at from .ab-log.jsonl
//                                                      -> {"ok","dry_run","wrote","stamped","blank","no_history","unchanged","counts"}
//   ab project-refresh '<json>' | ab project-refresh [-] < project.json
//                                                      rewrites the milestones in project.ts (the project tab) from
//                                                      {"title"?,"parent"?:{"id","url"},"updated_at"?:"<ISO with zone, default now>",
//                                                      "milestones":[{"id":"PROJ-101","done":17,"in_progress":0,"left":1,"total":18,
//                                                      "key"?,"title"?,"url"?},...]}
//                                                      Milestones follow the input order. key/title/url are kept from project.ts for a known
//                                                      id; a new id needs key, title and url. title and parent are kept when left out.
//                                                      Strict (exit 2, project.ts unchanged): milestones a non-empty array, ids
//                                                      unique with no spaces, counts non-negative integers, in_progress <= left,
//                                                      done + left == total. -> {"ok","milestones","totals":{done,in_progress,left,total},"updated_at"}
// Exit codes: 0 ok, 1 check/lint found problems, 2 bad input (including input that is not JSON) or a corrupt file, 3 written but the live server does not
// serve it (raise only), 4 refused (answered, cleared, or already on the board), 5 unknown id or lock timeout.
// Stamps: a new raise sets created_at (given or now) and updated_at = created_at ("added" on the card). A re-raise replaces
// the card in place (same slot), keeps its created_at (a given one is ignored) and sets updated_at = now; so does answer.
// updated_at is set by ab only, so raise refuses it as input.
// Writes are serialized by a lock dir (board.ts.lock: wait up to 10s then exit 5; stale after 30s) and replace board.ts
// atomically (unique temp file, fsync, rename). A corrupt board (not exactly one START/END marker) is refused, exit 2.
// project-refresh uses the same lock and atomic replace on project.ts (lock project.ts.lock).
// Env: AB_FILE (board.ts), AB_PROJECT_FILE (default project.ts next to AB_FILE), AB_URL (default
// http://127.0.0.1:<ACTION_BOARD_PORT>), ACTION_BOARD_HOST and ACTION_BOARD_PORT (shell, then app/.env.local; defaults
// board.localhost and 8085, used for AB_URL and the card footer), AB_MAX_HIGH (open high cards allowed before check
// flags a flood; positive integer, default 10), AB_NO_SERVER=1 (tests).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = process.env.AB_FILE || fileURLToPath(new URL("../app/src/data/board.ts", import.meta.url));
const APP_DIR = path.join(path.dirname(FILE), "..", "..");
// A setting from the shell, else from app/.env.local (plain KEY=value lines), else undefined.
function setting(key) {
  if (process.env[key]) return process.env[key];
  try {
    const line = fs.readFileSync(path.join(APP_DIR, ".env.local"), "utf8").split("\n").filter((l) => l.startsWith(key + "=")).pop();
    return line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") || undefined;
  } catch { return undefined; }
}
const PORT = Number(setting("ACTION_BOARD_PORT")) || 8085;
const HOST = (setting("ACTION_BOARD_HOST") || "board.localhost").toLowerCase();
const URL_ = process.env.AB_URL || "http://127.0.0.1:" + PORT;
const MAX_HIGH = Number(process.env.AB_MAX_HIGH ?? 10);
const TOMB = path.join(APP_DIR, ".ab-cleared.jsonl");
const LOG = path.join(APP_DIR, ".ab-log.jsonl");
const A = "/* BOARD-JSON-START */", Z = "/* BOARD-JSON-END */";
const PROJECT_FILE = process.env.AB_PROJECT_FILE || path.join(path.dirname(FILE), "project.ts");
const PA = "/* PROJECT-JSON-START */", PZ = "/* PROJECT-JSON-END */";
const ALLOWED = new Set(["id", "title", "card_ref", "context", "question", "what_happens_after", "details", "options", "multiSelect", "allowCustom", "priority", "blocking", "blocks", "created_at"]);
// Priority: missing (or anything else in a hand-edited file) means medium.
const PRIORITIES = ["high", "medium", "low"];
const isPriority = (v) => typeof v === "string" && PRIORITIES.includes(v);
const priorityOf = (d) => (isPriority(d.priority) ? d.priority : "medium");
// Blocking: true or false; a card raised before the field existed has none (null, unknown, never an error).
const blockingOf = (d) => (typeof d.blocking === "boolean" ? d.blocking : null);
const blockingError = (d) => d.blocking === true && d.priority !== "high" ? "blocking is true but priority is " + priorityOf(d) + "; blocking cards must be high (fix with ab priority " + d.id + " high)" : null;
const BLOCKS_RULE = "a card is blocking only when a named piece of in-flight work (a specific open PR, merge or task being actively driven) cannot move until the user answers";
const hasBlocks = (d) => typeof d.blocks === "string" && !!d.blocks.trim();
const blocksError = (d) => d.blocking === true && !hasBlocks(d) ? "blocking is true but blocks is empty: name the in-flight work it holds up, or raise " + d.id + " again with blocking:false" : null;

// Plain-words rules, shared by raise and lint. Each check returns an error that names the field, or null.
// Ids say nothing on their own: URLs, ABC-1234, #123.
const IDS = /https?:\/\/\S+|\b[A-Za-z]+-\d+\b|#\d+/g;
const words = (s) => s.replace(IDS, " ").match(/\p{L}+/gu) || [];
const EXAMPLE = "the Q3 vendor contract";
const THING = "ticket|tickets|pr|prs|pull\\s+request|issue|card|bug|fix|change|branch|item|one";
const NEXT = "is|are|was|were|be|been|should|will|would|can|could|go|get|stay|need|needs|has|have|do|does";
const VAGUE = [
  // "the ticket?", "Should the PR be merged?"
  new RegExp(`\\b(?:the|this|that|these|those)\\s+(?:${THING})(?=\\s*$|\\s*[?.!,;:]|\\s+(?:${NEXT})\\b)`, "i"),
  /\bit\b/i,                                    // "Send it back to the vendor?"
  /\b(?:this|that)(?=\s*$|\s*[?.!,;:])/i,       // "Ship that?"
];
function contextError(c) {
  if (typeof c !== "string" || !c.trim()) return "context is required: 1 to 3 sentences saying what the item is in plain words (the feature or screen, not just an id) and what happened that needs the user's call";
  const t = c.trim();
  if (t.length > 600) return "context is " + t.length + " chars; keep it to 600 or fewer (1 to 3 sentences)";
  const n = t.split(/[.!?](?=\s|$)/).filter((s) => s.trim()).length;
  if (n > 3) return "context has " + n + " sentences; keep it to 1 to 3 (put the rest in details)";
  if (words(t).length < 6) return "context needs at least 6 plain words besides ids: say what the item is (feature or screen) and what happened";
  return null;
}
function questionError(q) {
  if (typeof q !== "string" || !q.trim()) return "question is required";
  for (const re of VAGUE) { const m = q.match(re); if (m) return "question: \"" + m[0] + "\" is vague. Name the thing in plain words, for example \"" + EXAMPLE + "\"."; }
  return null;
}
const TITLE_EXAMPLE = "for example \"Q3 vendor contract renewal\"";
function titleError(t) {
  if (typeof t !== "string" || !t.trim()) return "title is required: a short bold topic for the top of the card, " + TITLE_EXAMPLE;
  const s = t.trim();
  if (/[\r\n]/.test(t)) return "title must be one line (no line breaks), " + TITLE_EXAMPLE;
  if (s.length > 60) return "title is " + s.length + " chars; keep it to 60 or fewer, a short topic " + TITLE_EXAMPLE;
  if (words(s).filter((w) => !/^(pr|ticket|issue)$/i.test(w)).length >= 2) return null;
  return "title: \"" + s + "\" is only an id. Add plain words saying what it is, for example \"ABC-1234 Checkout button color\".";
}
// The stored-field rules, shared by raise and lint.
const storedProblems = (d) => [contextError(d.context), questionError(d.question), titleError(d.title)].filter(Boolean);

// details: a non-empty array of non-blank strings or {label, items, ordered?} objects. Returns an error or null.
function detailsError(v) {
  if (!Array.isArray(v) || !v.length) return "details must be a non-empty array (leave it out when there is nothing)";
  for (let n = 0; n < v.length; n++) {
    const e = v[n], at = "details[" + n + "]";
    if (typeof e === "string") { if (!e.trim()) return at + " is a blank string"; continue; }
    if (!e || typeof e !== "object" || Array.isArray(e)) return at + " must be a string or {\"label\",\"items\",\"ordered\"?}";
    for (const k of Object.keys(e)) if (!["label", "items", "ordered"].includes(k)) return at + " has unknown key " + k + " (allowed: label, items, ordered)";
    if (typeof e.label !== "string" || !e.label.trim()) return at + ".label must be a non-empty string";
    if (!Array.isArray(e.items) || !e.items.length || e.items.some((x) => typeof x !== "string" || !x.trim())) return at + ".items must be a non-empty array of non-empty strings";
    if ("ordered" in e && typeof e.ordered !== "boolean") return at + ".ordered must be true or false";
  }
  return null;
}
// details as plain text lines for the chat card: "- item", "Label:", "1. item".
const detailsText = (v) => v.flatMap((e) => typeof e === "string" ? ["- " + e]
  : [e.label + ":", ...e.items.map((x, i) => (e.ordered ? i + 1 + ". " : "- ") + x)]).join("\n");

const die = (code, msg) => { console.error("ab: " + msg); process.exit(code); };
// Writers take LOCK before load() and hold it until save() is done (released before waiting on the server, or at exit).
const LOCK = FILE + ".lock";
let held = null;
const unlock = () => { if (held) { fs.rmSync(held, { recursive: true, force: true }); held = null; } };
process.on("exit", unlock);
function lock(dir = LOCK) {
  const end = Date.now() + 10000;
  while (true) {
    try { fs.mkdirSync(dir); held = dir; return; } catch (e) { if (e.code !== "EEXIST") throw e; }
    try { if (Date.now() - fs.statSync(dir).mtimeMs > 30000) { fs.rmSync(dir, { recursive: true, force: true }); continue; } } catch {}
    if (Date.now() > end) die(5, (dir === LOCK ? "board" : "project") + " is locked by another ab for over 10s: " + dir + " (remove it if no ab is running)");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}
// soft: return { error } instead of exiting (open/check report it as a problem).
function load(soft) {
  const s = fs.readFileSync(FILE, "utf8");
  const bad = (m) => soft ? { error: "board is corrupt: " + m + " in " + FILE } : die(2, "board is corrupt: " + m + " in " + FILE + "; refusing to read or write it");
  const nA = s.split(A).length - 1, nZ = s.split(Z).length - 1;
  if (nA !== 1 || nZ !== 1) return bad(nA + " BOARD-JSON-START and " + nZ + " BOARD-JSON-END markers (need exactly one each)");
  const i = s.indexOf(A) + A.length, j = s.indexOf(Z);
  if (j < i) return bad("BOARD-JSON-END comes before BOARD-JSON-START");
  if (!/^\s*;?\s*$/.test(s.slice(j + Z.length))) return bad("unexpected text after BOARD-JSON-END");
  try { return { s, i, j, b: JSON.parse(s.slice(i, j)) }; } catch (e) { return bad("board JSON does not parse (" + e.message + ")"); }
}
// Atomic replace: unique temp file in the same directory, fsync, rename over file.
function writeAtomic(file, text) {
  const tmp = file + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
  try {
    const fd = fs.openSync(tmp, "wx");
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}
function save({ s, i, j }, b) {
  b.updated_at = new Date().toISOString();
  writeAtomic(FILE, s.slice(0, i) + "\n" + JSON.stringify(b, null, 2) + "\n" + s.slice(j));
  return b.updated_at;
}
// project.ts: the JSON between the PROJECT markers. Missing file, bad markers or bad JSON: exit 2.
function loadProject() {
  const bad = (m) => die(2, "project file " + m + ": " + PROJECT_FILE + "; refusing to read or write it");
  if (!fs.existsSync(PROJECT_FILE)) bad("not found");
  const s = fs.readFileSync(PROJECT_FILE, "utf8");
  if (s.split(PA).length !== 2 || s.split(PZ).length !== 2) bad("needs exactly one PROJECT-JSON-START and one PROJECT-JSON-END marker");
  const i = s.indexOf(PA) + PA.length, j = s.indexOf(PZ);
  if (j < i) bad("has PROJECT-JSON-END before PROJECT-JSON-START");
  let p; try { p = JSON.parse(s.slice(i, j)); } catch (e) { bad("JSON does not parse (" + e.message + ")"); }
  if (!p || typeof p !== "object" || !Array.isArray(p.milestones)) bad("has no milestones array");
  return { s, i, j, p };
}
const COUNTS = ["done", "in_progress", "left", "total"];
const nonBlank = (v) => typeof v === "string" && !!v.trim();
const isHttp = (v) => /^https?:\/\//.test(v);
// project-refresh input -> the new title, parent and milestones, or an error naming the field. old: project.ts as it is.
function projectData(input, old) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "input must be a JSON object {\"title\"?,\"parent\"?,\"updated_at\"?,\"milestones\":[...]}" };
  for (const k of Object.keys(input)) if (!["title", "parent", "updated_at", "milestones"].includes(k)) return { error: "unknown key " + k + " (allowed: title, parent, updated_at, milestones)" };
  if ("title" in input && (!nonBlank(input.title) || input.title.trim().length > 60)) return { error: "title must be a non-blank string of 60 chars or fewer" };
  if ("parent" in input) {
    const p = input.parent;
    if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some((k) => k !== "id" && k !== "url") || !nonBlank(p.id) || !nonBlank(p.url) || !isHttp(p.url)) return { error: "parent must be {\"id\",\"url\"} with non-blank strings and an http(s) url" };
  }
  if (!Array.isArray(input.milestones) || !input.milestones.length) return { error: "milestones must be a non-empty array" };
  const seen = new Set(), out = [];
  for (const [n, m] of input.milestones.entries()) {
    const at = "milestones[" + n + "]";
    if (!m || typeof m !== "object" || Array.isArray(m)) return { error: at + " must be an object {id, done, in_progress, left, total, key?, title?, url?}" };
    for (const k of Object.keys(m)) if (!["id", "key", "title", "url", ...COUNTS].includes(k)) return { error: at + " has unknown key " + k };
    if (typeof m.id !== "string" || !/^\S{1,80}$/.test(m.id)) return { error: at + ".id must be a non-blank string with no spaces, like PROJ-101" };
    const who = at + " (" + m.id + ")";
    if (seen.has(m.id)) return { error: who + " is a duplicate id" };
    seen.add(m.id);
    for (const k of COUNTS) if (!Number.isInteger(m[k]) || m[k] < 0) return { error: who + "." + k + " must be a non-negative integer" };
    if (m.in_progress > m.left) return { error: who + ": in_progress (" + m.in_progress + ") must not exceed left (" + m.left + "); left includes in progress" };
    if (m.done + m.left !== m.total) return { error: who + ": done + left (" + m.done + " + " + m.left + " = " + (m.done + m.left) + ") must equal total (" + m.total + ")" };
    for (const k of ["key", "title", "url"]) if (k in m && !nonBlank(m[k])) return { error: who + "." + k + " must be a non-blank string" };
    if ("url" in m && !isHttp(m.url)) return { error: who + ".url must start with http:// or https://" };
    const known = old.milestones.find((x) => x.id === m.id) || {};
    const key = (m.key ?? known.key)?.trim(), title = (m.title ?? known.title)?.trim(), url = m.url ?? known.url;
    if (!key || !title || !url) return { error: who + " is new: give its key (like \"M5\"), title and url" };
    out.push({ key, id: m.id, title, url, done: m.done, in_progress: m.in_progress, left: m.left, total: m.total });
  }
  return { title: input.title?.trim() ?? old.title, parent: input.parent ?? old.parent, milestones: out };
}
const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
const tombstones = () => fs.existsSync(TOMB) ? fs.readFileSync(TOMB, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
// The latest tombstone line for id (a clear {id, reason, at, card?} or a restore marker {id, restored, at}), or undefined.
const lastTomb = (id) => tombstones().filter((t) => t.id === id).pop();
// Cleared means the latest line for the id is a clear, not a restore marker.
const isCleared = (id) => { const t = lastTomb(id); return !!t && !t.restored; };
async function served() {
  if (process.env.AB_NO_SERVER) return null;
  try { const r = await fetch(URL_ + "/__ab/board", { cache: "no-store" }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function waitServed(pred, ms = 4000) {
  unlock();                                           // written already; don't block other writers while polling
  if (process.env.AB_NO_SERVER) return true;
  const end = Date.now() + ms;
  while (Date.now() < end) { const b = await served(); if (b && pred(b)) return true; await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
function flag(args, name) { const k = args.indexOf(name); if (k < 0) return undefined; const v = args[k + 1]; args.splice(k, 2); return v; }
const isOpen = (d) => !d.answer;

const [cmd, ...args] = process.argv.slice(2);
const input = () => (args[0] && args[0].trim().startsWith("{") ? args[0] : fs.readFileSync(0, "utf8"));
// Input that is not valid JSON is bad input: exit 2, nothing written.
const parseInput = (text) => { try { return JSON.parse(text); } catch (e) { die(2, cmd + ": input is not valid JSON (" + e.message + ")"); } };

if (cmd === "raise") {
  const d = parseInput(input());
  if (!d || typeof d !== "object" || Array.isArray(d)) die(2, "raise: input must be a JSON object");
  const link = d.link; delete d.link;                 // card-only field, not board schema
  if (link && !d.card_ref) d.card_ref = link;
  for (const k of Object.keys(d)) if (!ALLOWED.has(k)) die(2, "unknown field " + k + " (allowed: " + [...ALLOWED].join(", ") + ", link)");
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(d.id || "")) die(2, "id must be lowercase-kebab, 3-81 chars");
  if (!d.question || !d.what_happens_after) die(2, "need question and what_happens_after in plain words");
  if (!Array.isArray(d.options) || !d.options.length) die(2, "need at least one option");
  const ids = d.options.map((o) => o.id);
  if (d.options.some((o) => !o.id || !o.label) || new Set(ids).size !== ids.length || ids.includes("custom")) die(2, "options need unique id+label; 'custom' is reserved");
  for (const k of ["multiSelect", "allowCustom"]) if (k in d && typeof d[k] !== "boolean") die(2, k + " must be true or false");
  if ("details" in d) { const e = detailsError(d.details); if (e) die(2, e); }
  if ("priority" in d && !isPriority(d.priority)) die(2, "priority must be high, medium or low");
  if (typeof d.blocking !== "boolean") die(2, "blocking is required: true if this card blocks a PR, merge, ticket or task, else false");
  if (d.blocking && "priority" in d && d.priority !== "high") die(2, "blocking cards are always high priority: drop priority or pass \"high\" (got \"" + d.priority + "\")");
  if (d.blocking && (!hasBlocks(d) || d.blocks.trim().length > 200)) die(2, "blocking:true needs \"blocks\" (1 to 200 chars) naming the work it blocks: " + BLOCKS_RULE);
  if (!d.blocking && "blocks" in d) die(2, "blocks is only for blocking:true cards: " + BLOCKS_RULE);
  if (d.blocking) { d.priority = "high"; d.blocks = d.blocks.trim(); }
  const problems = storedProblems(d);
  if (problems.length) die(2, problems.join("\nab: "));
  d.context = d.context.trim();
  const title = d.title.trim();
  lock();
  if (isCleared(d.id)) die(4, "refusing: " + d.id + " was cleared before; use a new id only for a genuinely new decision");
  const f = load();
  const k = f.b.decisions.findIndex((x) => x.id === d.id);
  if (k >= 0 && f.b.decisions[k].answer) die(4, "refusing: " + d.id + " is already answered; never restore an answered decision");
  d.card_ref = d.card_ref ?? null;
  // A re-raise without priority keeps the stored one; a new card without it stays without it (medium). Blocking set it above.
  if (!("priority" in d) && k >= 0 && "priority" in f.b.decisions[k]) d.priority = f.b.decisions[k].priority;
  // created_at and updated_at go last, side by side. New: updated_at = created_at. Re-raise: updated_at = now,
  // and the stored created_at wins over a passed one (a passed one only fills a card that has none).
  const created = (k >= 0 && f.b.decisions[k].created_at) || d.created_at || (k >= 0 ? undefined : new Date().toISOString());
  delete d.created_at;
  if (created) d.created_at = created;
  d.updated_at = k >= 0 ? new Date().toISOString() : created;
  // title goes first after id.
  const { id, title: _t, ...rest } = d;
  const stored = { id, title, ...rest };
  k >= 0 ? (f.b.decisions[k] = stored) : f.b.decisions.push(stored);
  save(f, f.b);
  const live = await waitServed((b) => b.decisions.some((x) => x.id === d.id && !x.answer && x.question === d.question));
  log({ op: "raise", id: d.id, live });
  if (!live) die(3, "written to board.ts but the live board at " + URL_ + " does not serve it. Is the dev server running (./start.sh in the repo)? Do NOT send the chat card until this passes.");
  console.log(JSON.stringify({ ok: true, board: "live", card: {
    title, context: d.context, question: d.question, ...(d.details ? { details: detailsText(d.details) } : {}), what_happens_after: d.what_happens_after,
    options: d.options.map((o) => o.label), multiSelect: !!d.multiSelect, allowCustom: d.allowCustom !== false,
    link: d.card_ref, decision_id: d.id, priority: priorityOf(d), blocking: d.blocking, blocks: d.blocks ?? null,
    footer: "Also on your Action Board: http://" + HOST + ":" + PORT + " (" + d.id + ")" } }, null, 2));
} else if (cmd === "answer") {
  const by = flag(args, "--by"), at = flag(args, "--at") || new Date().toISOString(), custom = flag(args, "--custom");
  const id = args[0];
  if (!id || !["chat", "app"].includes(by)) die(2, "usage: ab answer <id> <opt[,opt]>|--custom text --by chat|app [--at ISO]");
  lock(); const f = load(); const d = f.b.decisions.find((x) => x.id === id);
  if (!d) die(5, "no decision " + id + " on the board");
  if (d.answer) { console.log(JSON.stringify({ ok: true, status: "already-answered", answer: d.answer })); process.exit(0); }
  let a;
  if (custom !== undefined) { const t = custom.trim(); if (!t) die(2, "blank custom text"); if (d.allowCustom === false) die(2, id + " does not allow a custom answer (allowCustom is false); pick an option id"); a = { answer: "custom", answer_label: t, answered_by: by, answered_at: at, custom_text: t }; }
  else {
    const pick = (args[1] || "").split(",").filter(Boolean); if (!pick.length) die(2, "need an option id");
    for (const x of pick) if (!d.options.some((o) => o.id === x)) die(2, "unknown option " + x);
    if (pick.length > 1 && !d.multiSelect) die(2, id + " is single-select");
    const p = d.options.filter((o) => pick.includes(o.id));
    a = d.multiSelect ? { answer: p.map((o) => o.id), answer_label: p.map((o) => o.label), answered_by: by, answered_at: at } : { answer: p[0].id, answer_label: p[0].label, answered_by: by, answered_at: at };
  }
  d.updated_at = new Date().toISOString(); d.answer = a; save(f, f.b);
  const live = await waitServed((b) => b.decisions.some((x) => x.id === id && x.answer));
  log({ op: "answer", id, by, live });
  console.log(JSON.stringify({ ok: true, status: "answered", live, answer: a }));
} else if (cmd === "clear") {
  const reason = flag(args, "--reason"); const id = args[0];
  if (!id || !reason) die(2, "usage: ab clear <id> --reason \"why\"");
  lock(); const f = load(); const card = f.b.decisions.find((x) => x.id === id);
  if (!card) die(5, "no decision " + id);
  f.b.decisions = f.b.decisions.filter((x) => x.id !== id);
  save(f, f.b);
  // The tombstone keeps the removed card as it was, so ab restore can bring it back.
  fs.appendFileSync(TOMB, JSON.stringify({ id, reason, at: new Date().toISOString(), card }) + "\n");
  log({ op: "clear", id });
  console.log(JSON.stringify({ ok: true, status: "cleared", id }));
} else if (cmd === "restore") {
  const id = args[0];
  if (!id || args.length !== 1) die(2, "usage: ab restore <id>");
  lock(); const f = load();
  if (f.b.decisions.some((x) => x.id === id)) die(4, id + " is already on the board");
  const t = lastTomb(id);
  if (!t || t.restored) die(5, "nothing to restore for " + id);
  if (!t.card || typeof t.card !== "object") die(4, id + " was cleared without a saved card; it cannot be restored");
  // Back at the end and open again; every other field (priority, created_at, updated_at) as it was saved.
  const { answer, ...card } = t.card;
  f.b.decisions.push(card); save(f, f.b);
  fs.appendFileSync(TOMB, JSON.stringify({ id, restored: true, at: new Date().toISOString() }) + "\n");
  await waitServed((b) => b.decisions.some((x) => x.id === id));
  log({ op: "restore", id });
  console.log(JSON.stringify({ ok: true, status: "restored", id }));
} else if (cmd === "priority") {
  const [id, level] = args;
  if (!id || !isPriority(level) || args.length !== 2) die(2, "usage: ab priority <id> <high|medium|low>");
  lock(); const f = load(); const d = f.b.decisions.find((x) => x.id === id);
  if (!d) die(5, "no decision " + id + " on the board");
  if (d.answer) die(4, id + " is already answered");
  if (d.blocking === true && level !== "high") die(2, id + " is a blocking card; blocking cards stay high");
  const was = priorityOf(d);
  // Only this card's priority changes; its updated_at stays (save() moves the board's own updated_at).
  d.priority = level; save(f, f.b);
  const live = await waitServed((b) => b.decisions.some((x) => x.id === id && x.priority === level));
  log({ op: "priority", id, priority: level });
  console.log(JSON.stringify({ ok: true, id, priority: level, was, live }));
} else if (cmd === "glance") {
  const g = parseInput(fs.readFileSync(0, "utf8"));
  if (!g || typeof g !== "object" || Array.isArray(g)) die(2, "glance: input must be a JSON object");
  for (const k of ["waiting", "tickets"]) if (!Array.isArray(g[k])) die(2, "glance." + k + " must be an array");
  if ("parked" in g && !Array.isArray(g.parked)) die(2, "glance.parked must be an array");
  if (g.parked?.length) die(2, "glance.parked is retired: raise those as decisions with \"ab raise\" instead");
  // others: someone else's PR involving the user. Missing means []; each item is exactly {title, author, who, link}.
  const others = g.others ?? [];
  if (!Array.isArray(others)) die(2, "glance.others must be an array");
  const OTHER_KEYS = ["title", "author", "who", "link"];
  others.forEach((o, n) => {
    const at = "glance.others[" + n + "]";
    if (!o || typeof o !== "object" || Array.isArray(o)) die(2, at + " must be an object {title, author, who, link}");
    for (const k of Object.keys(o)) if (!OTHER_KEYS.includes(k)) die(2, at + " has unknown key " + k);
    for (const k of OTHER_KEYS) if (typeof o[k] !== "string" || !o[k].trim()) die(2, at + "." + k + " must be a non-blank string");
    if (!/^https?:\/\//.test(o.link)) die(2, at + ".link must start with http:// or https://");
  });
  lock(); const f = load(); f.b.glance = { waiting: g.waiting, tickets: g.tickets, others };
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "glance", live });
  console.log(JSON.stringify({ ok: true, live, counts: { waiting: g.waiting.length, tickets: g.tickets.length, others: others.length } }));
} else if (cmd === "open" || cmd === "check") {
  const chatArg = flag(args, "--chat");
  if (!Number.isInteger(MAX_HIGH) || MAX_HIGH < 1) die(2, "AB_MAX_HIGH must be a positive integer");
  const f = load(true);
  if (f.error) { console.log(JSON.stringify({ ok: false, open_on_board: null, served_open: null, counts: null, priority_open: null, open_priority: null, problems: [f.error] }, null, 2)); process.exit(1); }
  // Glance list sizes in the file; a missing list (older files have no others) counts 0.
  const counts = Object.fromEntries(["waiting", "tickets", "others"].map((k) => [k, Array.isArray(f.b.glance?.[k]) ? f.b.glance[k].length : 0]));
  const fileB = f.b; const srv = await served();
  const fileOpen = fileB.decisions.filter(isOpen).map((d) => d.id);
  // Over open decisions only; a missing priority counts as medium.
  const openPriority = fileB.decisions.filter(isOpen).map((d) => ({ id: d.id, priority: priorityOf(d), blocking: blockingOf(d), blocks: hasBlocks(d) ? d.blocks : null }));
  const priorityOpen = Object.fromEntries(PRIORITIES.map((p) => [p, openPriority.filter((x) => x.priority === p).length]));
  const srvOpen = srv ? srv.decisions.filter(isOpen).map((d) => d.id) : null;
  const problems = fileB.decisions.filter(isOpen).flatMap((d) => [blockingError(d), blocksError(d)]).filter(Boolean);
  if (priorityOpen.high > MAX_HIGH) problems.push(priorityOpen.high + " open cards are high (limit " + MAX_HIGH + "): a flood of high cards hides the real blockers");
  if (!process.env.AB_NO_SERVER) {
    if (!srv) problems.push("live board not reachable at " + URL_ + " (dev server down?)");
    else if (srv.updated_at !== fileB.updated_at) problems.push("served board is stale: file " + fileB.updated_at + " vs served " + srv.updated_at);
  }
  let missing = [], boardOnly = [];
  if (chatArg !== undefined) {
    const chat = chatArg.split(",").map((s) => s.trim()).filter(Boolean);
    missing = chat.filter((id) => !fileOpen.includes(id));
    boardOnly = fileOpen.filter((id) => !chat.includes(id));
    const answered = new Set(fileB.decisions.filter((d) => d.answer).map((d) => d.id));
    for (const id of missing) problems.push(answered.has(id) ? "chat card " + id + " is answered on the board: clear the chat card" : "chat card " + id + " is NOT on the board: run ab raise for it");
    for (const id of boardOnly) problems.push("board decision " + id + " has no open chat card: card it from `ab raise` output, or ab clear it");
  }
  console.log(JSON.stringify({ ok: problems.length === 0, open_on_board: fileOpen, served_open: srvOpen, counts, priority_open: priorityOpen, open_priority: openPriority, problems }, null, 2));
  if (cmd === "check" && problems.length) process.exit(1);
} else if (cmd === "lint") {
  const failing = load().b.decisions.filter(isOpen).map((d) => ({ id: d.id, problems: [...storedProblems(d), blockingError(d), blocksError(d)].filter(Boolean) })).filter((x) => x.problems.length);
  console.log(JSON.stringify({ ok: failing.length === 0, failing }, null, 2));
  if (failing.length) process.exit(1);
} else if (cmd === "backfill-stamps") {
  const dry = args[0] === "--dry-run";
  if (args.length > (dry ? 1 : 0)) die(2, "usage: ab backfill-stamps [--dry-run]");
  lock(); const f = load();
  // Log lines per id, in file order; unparseable lines and lines without an id or a valid time are skipped.
  const hist = new Map();
  for (const l of fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n") : []) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (!o || typeof o.id !== "string" || typeof o.at !== "string" || Number.isNaN(Date.parse(o.at))) continue;
    if (!hist.has(o.id)) hist.set(o.id, []);
    hist.get(o.id).push(o);
  }
  const stamped = [], blank = [], noHistory = [];
  for (const d of f.b.decisions) {
    const lines = hist.get(d.id) || [];
    if (!lines.length) noHistory.push(d.id);
    // A raise is logged ~300ms after its board write, so the first raise is the creation; later raises and answers are updates.
    const ops = lines.filter((o) => o.op === "raise" || o.op === "answer");
    const first = ops.findIndex((o) => o.op === "raise");
    const later = first >= 0 ? ops.slice(first + 1) : ops;
    let changed = false;
    if (!(typeof d.created_at === "string" && d.created_at.trim()) && first >= 0) { d.created_at = ops[first].at; changed = true; }
    if (!d.updated_at) {
      const u = later.length ? later[later.length - 1].at : first >= 0 && d.created_at ? d.created_at : undefined;
      if (u) { d.updated_at = u; changed = true; }
    }
    if (changed) stamped.push(d.id);
    if (!d.created_at && !d.updated_at) blank.push(d.id);
  }
  const wrote = !dry && stamped.length > 0;
  if (wrote) { save(f, f.b); log({ op: "backfill-stamps", count: stamped.length }); }
  const total = f.b.decisions.length, unchanged = total - stamped.length;
  console.log(JSON.stringify({ ok: true, dry_run: dry, wrote, stamped, blank, no_history: noHistory, unchanged,
    counts: { stamped: stamped.length, blank: blank.length, no_history: noHistory.length, unchanged, total } }, null, 2));
} else if (cmd === "backfill-titles") {
  const map = parseInput(fs.readFileSync(0, "utf8"));
  if (!map || typeof map !== "object" || Array.isArray(map)) die(2, "backfill-titles reads {\"<decision id>\":\"<title>\"} on stdin");
  const bad = Object.entries(map).map(([id, t]) => { const e = titleError(t); return e && id + ": " + e; }).filter(Boolean);
  if (bad.length) die(2, bad.join("\nab: "));
  lock(); const f = load();
  const set = [], unknown = [], skippedAnswered = [], skippedHasTitle = [];
  const hasTitle = (d) => typeof d.title === "string" && !!d.title.trim();
  for (const [id, t] of Object.entries(map)) {
    const k = f.b.decisions.findIndex((x) => x.id === id), d = f.b.decisions[k];
    if (!d) unknown.push(id);
    else if (d.answer) skippedAnswered.push(id);
    else if (hasTitle(d)) skippedHasTitle.push(id);
    else { const { id: _i, title: _t, ...rest } = d; f.b.decisions[k] = { id, title: t.trim(), ...rest }; set.push(id); }
  }
  // Card stamps stay as they were; save() moves only the board's own updated_at.
  const wrote = set.length > 0;
  if (wrote) { save(f, f.b); log({ op: "backfill-titles", count: set.length }); }
  const stillMissing = f.b.decisions.filter((d) => isOpen(d) && !hasTitle(d)).map((d) => d.id);
  console.log(JSON.stringify({ ok: true, wrote, set, unknown, skipped_answered: skippedAnswered, skipped_has_title: skippedHasTitle, still_missing: stillMissing }, null, 2));
} else if (cmd === "project-refresh") {
  if (args.length > 1) die(2, "project-refresh: usage: ab project-refresh '<json>' | ab project-refresh [-] < project.json");
  const raw = args[0] === undefined || args[0] === "-" ? fs.readFileSync(0, "utf8") : args[0];
  let input; try { input = JSON.parse(raw); } catch (e) { die(2, "project-refresh: input is not valid JSON (" + e.message + ")"); }
  let updated = new Date().toISOString();
  if (input && typeof input === "object" && "updated_at" in input) {
    const u = input.updated_at;
    if (typeof u !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(u) || Number.isNaN(Date.parse(u))) die(2, "project-refresh: updated_at must be an ISO 8601 time with a zone, like 2026-11-23T18:35:00Z");
    updated = new Date(u).toISOString();
  }
  lock(PROJECT_FILE + ".lock");
  const f = loadProject();
  const r = projectData(input, f.p);
  if (r.error) die(2, "project-refresh: " + r.error);
  const p = { title: r.title, updated_at: updated, parent: r.parent, milestones: r.milestones };
  writeAtomic(PROJECT_FILE, f.s.slice(0, f.i) + "\n" + JSON.stringify(p, null, 2) + "\n" + f.s.slice(f.j));
  unlock();
  const totals = Object.fromEntries(COUNTS.map((k) => [k, r.milestones.reduce((n, m) => n + m[k], 0)]));
  log({ op: "project-refresh", milestones: r.milestones.length });
  console.log(JSON.stringify({ ok: true, milestones: r.milestones.length, totals, updated_at: updated }));
} else {
  die(2, "usage: ab raise|answer|clear|restore|priority|glance|open|check|lint|backfill-stamps|backfill-titles|project-refresh (see header of " + process.argv[1] + ")");
}
