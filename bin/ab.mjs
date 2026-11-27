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
//     Stored fields: id, title, card_ref, link, context, question, ... ("link", when given, also fills a missing card_ref).
//     Link guard (exit 2 "ab: raise: ...", board untouched): a card_ref or link on github.com must be exactly
//       https://github.com/<owner>/<repo>/pull/<number>, one on linear.app https://linear.app/<workspace>/issue/<KEY-N>
//       (either may go on with / ? #); a card_ref that is a bare PR ref (#42, example-web#42) or ticket key
//       (PROJ-1234) must match the link (same kind, number, repo when named, key). A bare ref without a link is allowed.
//     Law q: every PR or ticket named in title, context or question needs a matching URL in link, card_ref or the
//       card text. Refusals start with "ab: raise: law q:" and leave the board untouched.
//     User must understand the card cold, so raise refuses (exit 2, board untouched) a card that does not say what it is about:
//     "context" (required, shown first): 1 to 3 sentences, max 600 chars, at least 6 plain words besides ids (PROJ-1234, #123,
//       URLs). Say what the item is in plain words (feature or screen, not just an id) and what happened that needs the user’s call.
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
//     "blocks" (stored trimmed): the in-flight work this card blocks, e.g. "PR #43 hired application guard merge".
//     Required with blocking:true (non-empty after trim, max 200 chars); refused with blocking:false; else exit 2, board
//     untouched. A re-raise with blocking:false drops it. Printed on the card and in open (null when absent).
//     optional "priority": "high", "medium" or "low" (anything else: exit 2, board untouched). Left out: a new card is stored
//     without it (medium) unless blocking; a re-raise keeps the stored one. The printed card carries the effective priority
//     ("medium" if none), blocking and blocks.
//   ab lint-card '<json>' | ab lint-card < decision.json   -> validates a raise without opening or writing the board
//     Prints {"ok":true} (exit 0) or {"ok":false,"error":"..."} (exit 2, with "law":"q" for law q).
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
//                                                      others is optional (missing = []), each {title,author,who,link},
//                                                      non-blank strings, link http(s)) -> {"ok","live","counts":{waiting,tickets,others}}
//                                                      waiting and others items may carry base, head (non-blank strings: the PR's
//                                                      branches, for the PRs tab sections), hot (boolean), hot_by and hot_at
//                                                      (non-blank strings). An item whose canonical PR link has an entry in the
//                                                      board's hot map gets that entry (hot:true sets hot, hot:false drops it, plus
//                                                      hot_by/hot_at), over any incoming hot. Other items: an explicit hot wins, else
//                                                      an item with no hot key whose link was hot in the file keeps hot:true.
//   ab hot <pr-url> [--by name] | ab unhot <pr-url> [--by name]
//                                                      url: https://github.com/<owner>/<repo>/pull/<n> (a trailing / ? # is dropped:
//                                                      that canonical URL is the key); by: letters, digits, _ or -, max 32, default
//                                                      cli; else exit 2. Sets board.hot[url] = {hot:true|false,by,at} (unhot keeps a
//                                                      hot:false entry so it sticks across glance refreshes) and, on every glance
//                                                      PR with that link, sets / removes hot:true and sets hot_by, hot_at. A URL in
//                                                      no glance list just records the entry. -> {"ok","live","section","item","mark",
//                                                      "status":"changed"|"unchanged"} (section/item null when not in the glance;
//                                                      waiting first). Changed: appends {"at","kind":"hot"|"unhot","url","by"} to the
//                                                      event log after the board write; unchanged (entry already that value): no
//                                                      write, no event.
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
//   To-do list (todos.ts, the Board's "To-do" panel). JSON from the first argument when it starts with {, else stdin.
//   Strict: unknown keys, a blank or multi-line name over 200 chars, a priority other than urgent|high|medium|low,
//   or a parent_id that is not a top-level to-do: exit 2, todos.ts unchanged. Unknown id: exit 5. Each prints {"ok":true,...,"todo":{...}}.
//   ab todo-add '{"name","description"?,"priority"?,"parent_id"?,"id"?,"quick"?}'
//                                                      quick ("call the vendor p1") is parsed by app/src/quickadd.ts, the
//                                                      Board's parser; explicit fields win. name or quick required. priority
//                                                      defaults to medium; id (lowercase kebab) defaults to slug(name)-<6 hex>
//   ab todo-update '{"id",<any of name, description, priority, parent_id>}'   null clears description or parent_id
//   ab todo-comment '{"id","text","author"?}' [--author name]   text non-blank, max 4000; author defaults to "bot"
//   ab todo-done '{"id"}'                           sets done_at (subtasks stay as they are); already done -> "status":"already-done"
//   ab todo-reopen '{"id"}'                         clears done_at; already open -> "status":"already-open"
//   ab todo-list [--view today|upcoming|done|all]   -> JSON array (default all)
// Exit codes: 0 ok, 1 check/lint found problems, 2 bad input (including input that is not JSON) or a corrupt file, 3 written but the live server does not
// serve it (raise only), 4 refused (answered, cleared, or already on the board), 5 unknown id or lock timeout.
// Stamps: a new raise sets created_at (given or now) and updated_at = created_at ("added" on the card). A re-raise replaces
// the card in place (same slot), keeps its created_at (a given one is ignored) and sets updated_at = now; so does answer.
// updated_at is set by ab only, so raise refuses it as input.
// Writes are serialized by a lock dir (board.ts.lock: wait up to 10s then exit 5; stale after 30s) and replace board.ts
// in one atomic replace (unique temp file, fsync, rename). A corrupt board (not exactly one START/END marker) is refused, exit 2.
// project-refresh uses the same lock and atomic replace on project.ts (lock project.ts.lock).
// Env: AB_FILE (board.ts), AB_PROJECT_FILE (default project.ts next to AB_FILE), AB_URL (default
// http://127.0.0.1:<ACTION_BOARD_PORT>), ACTION_BOARD_HOST and ACTION_BOARD_PORT (shell, then app/.env.local; defaults
// board.localhost and 8085, used for AB_URL and the card footer), AB_MAX_HIGH (open high cards allowed before check
// flags a flood; positive integer, default 10), AB_NO_SERVER=1 (tests).
// A todos.ts without exactly one TODOS-JSON-START/END marker is refused by the todo commands (exit 2) and flagged by check.
// AB_TODOS_FILE defaults to todos.ts next to AB_FILE. AB_EVENTS_FILE defaults to data/events.jsonl in the repo.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [cmd, ...args] = process.argv.slice(2);
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
const PORT = (cmd !== "lint-card" && Number(setting("ACTION_BOARD_PORT"))) || 8085;
const HOST = ((cmd !== "lint-card" && setting("ACTION_BOARD_HOST")) || "board.localhost").toLowerCase();
const URL_ = process.env.AB_URL || "http://127.0.0.1:" + PORT;
const MAX_HIGH = Number(process.env.AB_MAX_HIGH ?? 10);
const TOMB = path.join(APP_DIR, ".ab-cleared.jsonl");
const LOG = path.join(APP_DIR, ".ab-log.jsonl");
const A = "/* BOARD-JSON-START */", Z = "/* BOARD-JSON-END */";
const PROJECT_FILE = process.env.AB_PROJECT_FILE || path.join(path.dirname(FILE), "project.ts");
const PA = "/* PROJECT-JSON-START */", PZ = "/* PROJECT-JSON-END */";
const TODOS_FILE = process.env.AB_TODOS_FILE || path.join(path.dirname(FILE), "todos.ts");
const DA = "/* TODOS-JSON-START */", DZ = "/* TODOS-JSON-END */";
// The app's shared to-do code (quick-add parser, views), loaded with Node's type stripping.
const APP_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "src");
const EVENTS_FILE = process.env.AB_EVENTS_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "events.jsonl");
const ALLOWED = new Set(["id", "title", "card_ref", "link", "context", "question", "what_happens_after", "details", "options", "multiSelect", "allowCustom", "priority", "blocking", "blocks", "created_at"]);
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

// Link guard (raise and re-raise). Idea and regexes from groupLinkError in Agent Board
// (agent-board, MIT; see THIRD_PARTY_NOTICES.md), rewritten here to parse with URL.
// A card_ref that is a bare PR ref (#123, repo#123) or ticket key (PROJ-1234) names the card; its link is "link",
// else a card_ref that is a URL. Anything mentioning github.com / linear.app must be the exact PR / issue URL form,
// and a link given with a bare ref must point at that same PR or ticket. Returns an error or null.
const GH_FORM = "https://github.com/<owner>/<repo>/pull/<number>";
const LIN_FORM = "https://linear.app/<workspace>/issue/<KEY-N>";
const PR_REPO = "(?:([a-z0-9-]+)/)?([a-z0-9._-]+)";
const PR_REF = new RegExp(`^(?:${PR_REPO})?#(\\d+)$`, "i");
const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const prNumber = (s) => s.replace(/^0+(?=\d)/, "");
function bareRef(s) {
  const t = typeof s === "string" ? s.trim() : "";
  const m = PR_REF.exec(t);
  if (m) return { kind: "pr", owner: m[1], repo: m[2], number: prNumber(m[3]), text: t };
  return TICKET_KEY.test(t) ? { kind: "ticket", key: t.toUpperCase(), text: t } : null;
}
// A github.com / linear.app link checked segment by segment: {kind, repo?, number?, key?} or {error}. null when the
// string is not on (or posing as) either host.
function parseLink(field, s) {
  const raw = s.trim();
  let u = null;
  try { u = new URL(raw); } catch {}
  const host = u ? u.hostname.toLowerCase() : "";
  const kind = host === "github.com" ? "pr" : host === "linear.app" ? "ticket"
    : /github\.com/i.test(raw) ? "pr" : /linear\.app/i.test(raw) ? "ticket" : null;
  if (!kind) return null;
  const want = field + " must be a " + (kind === "pr" ? "GitHub PR URL of the form " + GH_FORM : "Linear issue URL of the form " + LIN_FORM);
  const bad = (why, shown = raw) => ({ error: want + ", got " + shown + " (" + why + ")" });
  if (!u) return bad("it must start with https://");
  if (u.username || u.password) return bad("it has credentials before the host", "a URL with user:password@");
  if (u.protocol !== "https:") return bad("it must use https://");
  const expectHost = kind === "pr" ? "github.com" : "linear.app";
  if (host !== expectHost || u.port || !new RegExp("^https://" + expectHost.replace(".", "\\.") + "(?:/|$)", "i").test(raw)) return bad("the host must be exactly " + expectHost);
  const seg = u.pathname.split("/").slice(1);
  if (kind === "pr") {
    if (!/^[A-Za-z0-9-]+$/.test(seg[0] || "")) return bad("the owner is missing or invalid");
    if (!/^[A-Za-z0-9._-]+$/.test(seg[1] || "")) return bad("the repo is missing");
    if (seg[2] !== "pull") return bad("it must be a /pull/ URL, not " + (seg[2] ? "/" + seg[2] + "/" : "a repo page"));
    if (!/^\d+$/.test(seg[3] || "")) return bad("the PR number is missing");
    return { kind, owner: seg[0], repo: seg[1], number: prNumber(seg[3]) };
  }
  if (!/^[A-Za-z0-9-]+$/.test(seg[0] || "")) return bad("the workspace is missing or invalid");
  if (seg[1] !== "issue") return bad("it must be an /issue/ URL");
  if (!TICKET_KEY.test(seg[2] || "")) return bad("the ticket key (KEY-N) is missing");
  return { kind, key: seg[2].toUpperCase() };
}
function expectedLink(ref) {
  if (ref.kind === "ticket") return LIN_FORM.replace("<KEY-N>", ref.key);
  return GH_FORM.replace("<owner>", ref.owner ?? "<owner>").replace("<repo>", ref.repo ?? "<repo>").replace("<number>", ref.number);
}
function linkError(linkText, ref, l, cardRef) {
  if (cardRef?.error) return cardRef.error;
  if (l?.error) return l.error;
  if (!ref || typeof linkText !== "string") return null;
  const name = (k) => k === "pr" ? "a GitHub PR URL" : "a Linear issue URL";
  const expected = expectedLink(ref);
  if (!l) return "link must be " + name(ref.kind) + " for card_ref " + ref.text + " (" + expected + "), got " + linkText;
  if (l.kind !== ref.kind) return "link is " + name(l.kind) + " but card_ref " + ref.text + " is a " + (ref.kind === "pr" ? "PR" : "ticket") + "; use " + expected;
  if (ref.kind === "ticket") return l.key === ref.key ? null : "link ticket " + l.key + " does not match card_ref " + ref.text;
  if (l.number !== ref.number) return "link PR number " + l.number + " does not match card_ref " + ref.text;
  if (ref.repo && ref.repo.toLowerCase() !== l.repo.toLowerCase()) return "link repo " + l.repo + " does not match card_ref " + ref.text;
  if (ref.owner && ref.owner.toLowerCase() !== l.owner.toLowerCase()) return "link owner " + l.owner + " does not match card_ref " + ref.text;
  return null;
}

const LAW_Q = "law q: ";
const NON_TICKET_PREFIXES = new Set(["UTF", "ISO", "COVID", "SHA", "X"]);
const TEXT_TICKET = /(?<![\p{L}\p{N}_])([a-z]{2,10})-\d+(?![\p{L}\p{N}_])/giu;
const TEXT_PR = new RegExp(`(?<![\\p{L}\\p{N}_])(?:pr\\s*#?|pull\\s+)(\\d+)(?![\\p{L}\\p{N}_])|(?:(?<![\\p{L}\\p{N}._/-])${PR_REPO})?#(\\d+)(?![\\p{L}\\p{N}_])`, "giu");
const TEXT_URL = /\b(?:[a-z][a-z0-9+.-]*:\/\/|(?:github\.com|linear\.app)\/)[^\s<>"'`\])]+/gi;
const EVIDENCE_PATH = /github\.com[^?#]*\/pull(?:[/?#]|$)|linear\.app[^?#]*\/issue(?:[/?#]|$)/i;

function matchesRef(ref, url) {
  if (url.kind !== ref.kind) return false;
  if (ref.kind === "ticket") return url.key === ref.key;
  return url.number === ref.number
    && (!ref.repo || url.repo.toLowerCase() === ref.repo.toLowerCase())
    && (!ref.owner || url.owner.toLowerCase() === ref.owner.toLowerCase());
}

function lawQError(d, link, cardRef) {
  const urls = [link, cardRef].filter((url) => url && !url.error);
  const refs = [];
  for (const field of ["title", "context", "question"]) {
    if (typeof d[field] !== "string") continue;
    for (const [raw] of d[field].matchAll(TEXT_URL)) {
      const url = raw.replace(/[.,;:!?]+$/, "");
      if (!EVIDENCE_PATH.test(url)) continue;
      const parsed = parseLink(field, url);
      if (!parsed || parsed.error) return LAW_Q + (parsed?.error ?? field + " has an invalid link") + ". Use the exact evidence URL.";
      urls.push(parsed);
    }
    const prose = d[field].replace(TEXT_URL, " ").replace(TEXT_PR, (_text, named, owner, repo, hash) => {
      refs.push({ kind: "pr", owner, repo, number: prNumber(named ?? hash) });
      return " ";
    });
    for (const [text, prefix] of prose.matchAll(TEXT_TICKET)) {
      if (!NON_TICKET_PREFIXES.has(prefix.toUpperCase())) refs.push({ kind: "ticket", key: text.toUpperCase() });
    }
  }
  for (const ref of refs) {
    const name = ref.kind === "ticket" ? "ticket " + ref.key
      : "PR " + (ref.owner ? ref.owner + "/" : "") + (ref.repo ? ref.repo + "#" : "") + ref.number;
    const fix = "add " + expectedLink(ref) + " in link, card_ref or the card text";
    if (link?.error || cardRef?.error) return LAW_Q + (link?.error ?? cardRef.error) + "; " + fix;
    if (!urls.some((url) => matchesRef(ref, url))) return LAW_Q + "card names " + name + "; " + fix;
  }
  return null;
}
// The canonical https://github.com/<owner>/<repo>/pull/<n> for a PR URL (a trailing /, ?query or #fragment dropped):
// {url} | {error} (a github.com URL the link guard refuses, or a PR sub-page like /files) | null (not a GitHub URL).
// The key of the board's hot map, and how glance PR links are matched to it.
function canonicalPr(s) {
  if (typeof s !== "string") return null;
  const p = parseLink("url", s);
  if (!p || p.error || p.kind !== "pr") return p?.error ? p : null;
  if (new URL(s.trim()).pathname.split("/").slice(5).some(Boolean)) return { error: "url must be a GitHub PR URL of the form " + GH_FORM + ", got " + s.trim() + " (nothing may follow the PR number but / ? #)" };
  return { url: "https://github.com/" + p.owner + "/" + p.repo + "/pull/" + p.number };
}
const prKey = (link) => canonicalPr(link)?.url ?? null;

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
    if (Date.now() > end) die(5, path.basename(dir, ".lock") + " is locked by another ab for over 10s: " + dir + " (remove it if no ab is running)");
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
// todos.ts: the JSON between the TODOS markers. Missing file, bad markers or bad JSON: exit 2 (soft: return { error }).
function loadTodos(soft) {
  const bad = (m) => soft ? { error: "todos file " + m + ": " + TODOS_FILE } : die(2, "todos file " + m + ": " + TODOS_FILE + "; refusing to read or write it");
  if (!fs.existsSync(TODOS_FILE)) return bad("not found");
  const s = fs.readFileSync(TODOS_FILE, "utf8");
  if (s.split(DA).length !== 2 || s.split(DZ).length !== 2) return bad("needs exactly one TODOS-JSON-START and one TODOS-JSON-END marker");
  const i = s.indexOf(DA) + DA.length, j = s.indexOf(DZ);
  if (j < i) return bad("has TODOS-JSON-END before TODOS-JSON-START");
  let t; try { t = JSON.parse(s.slice(i, j)); } catch (e) { return bad("JSON does not parse (" + e.message + ")"); }
  if (!t || typeof t !== "object" || !Array.isArray(t.items)) return bad("has no items array");
  return { s, i, j, t };
}
function saveTodos({ s, i, j }, t) {
  t.updated_at = new Date().toISOString();
  writeAtomic(TODOS_FILE, s.slice(0, i) + "\n" + JSON.stringify(t, null, 2) + "\n" + s.slice(j));
}
// Loads app/src/<name> (TypeScript) through Node's type stripping, without its experimental warning.
async function appModule(name) {
  if (!process.features?.typescript) die(2, "this command loads app/src/" + name + " and needs Node 22.18+ or 23.6+ (type stripping); this is " + process.version);
  const emit = process.emitWarning;
  process.emitWarning = (w, ...a) => (String(w).includes("Type Stripping") ? undefined : emit.call(process, w, ...a));
  return import(pathToFileURL(path.join(APP_SRC, name)).href);
}
const TODO_PRIORITIES = ["urgent", "high", "medium", "low"];
const TODO_ID = /^[a-z0-9][a-z0-9-]{2,80}$/;
const MAX_TEXT = 4000;
// Each returns an error naming the field, or null. Strings are stored trimmed.
function todoNameError(v) {
  if (typeof v !== "string" || !v.trim()) return "name must be a non-blank string";
  if (/[\r\n]/.test(v)) return "name must be one line";
  return v.trim().length > 200 ? "name is " + v.trim().length + " chars; keep it to 200 or fewer" : null;
}
const textError = (k, v) => typeof v !== "string" ? k + " must be a string" : v.trim().length > MAX_TEXT ? k + " is " + v.trim().length + " chars; keep it to " + MAX_TEXT + " or fewer" : null;
// A real calendar date: rolling it through Date.UTC gives the same day back (2026-02-30 and 2026-13-01 do not).
const isDate = (v) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number), t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
function dueError(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "due must be {\"date\":\"YYYY-MM-DD\",\"time\"?:\"HH:MM\"}";
  for (const k of Object.keys(v)) if (!["date", "time"].includes(k)) return "due has unknown key " + k + " (allowed: date, time)";
  if (!isDate(v.date)) return "due.date must be a real calendar date written YYYY-MM-DD, like 2026-11-27";
  if ("time" in v && !(typeof v.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.time))) return "due.time must be HH:MM (24-hour, Eastern), like 15:00";
  return null;
}
const priorityError = (v) => TODO_PRIORITIES.includes(v) ? null : "priority must be urgent, high, medium or low";
// A subtask's parent: an existing to-do that is not itself a subtask, and not the to-do itself.
function parentError(items, pid, self) {
  if (typeof pid !== "string" || !pid) return "parent_id must be a to-do id";
  const p = items.find((x) => x.id === pid);
  if (!p) return "parent_id " + pid + " is not a to-do";
  if (p.parent_id) return "parent_id " + pid + " is a subtask itself; subtasks go one level deep";
  if (self && pid === self.id) return "a to-do cannot be its own parent";
  if (self && items.some((x) => x.parent_id === self.id)) return self.id + " has subtasks, so it cannot become a subtask (one level deep)";
  return null;
}
// A todo command's JSON input: an object with only the allowed keys (and a non-empty id unless adding), else exit 2.
function todoInput(name, allowed) {
  const no = (m) => die(2, name + ": " + m);
  if (args.length > 1 || (args.length && !args[0].trim().startsWith("{"))) no("usage: ab " + name + " '<json>' | ab " + name + " < input.json");
  let v; try { v = JSON.parse(input()); } catch (e) { no("input is not valid JSON (" + e.message + ")"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) no("input must be a JSON object");
  for (const k of Object.keys(v)) if (!allowed.includes(k)) no("unknown key " + k + " (allowed: " + allowed.join(", ") + ")");
  if (name !== "todo-add" && (typeof v.id !== "string" || !v.id)) no("id is required");
  return { v, no };
}
// The stored to-do for an id under the todos lock; unknown id exit 5.
function findTodo(f, name, id) {
  const t = f.t.items.find((x) => x.id === id);
  return t || die(5, name + ": no to-do " + id);
}
// Stored key order, so todos.ts reads the same whichever command wrote it.
const todoOrder = (t) => Object.fromEntries(["id", "name", "description", "priority", "due", "parent_id", "comments", "created_at", "updated_at", "done_at"].filter((k) => t[k] !== undefined).map((k) => [k, t[k]]));
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "") || "todo";
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
const PR_KEYS = ["base", "head", "hot", "hot_by", "hot_at"];
// Writes one explicit HOT mark onto a glance PR item: hot:true sets hot, hot:false drops it; hot_by/hot_at always.
const applyMark = (x, m) => { if (m.hot) x.hot = true; else delete x.hot; x.hot_by = m.by; x.hot_at = m.at; };

const input = () => (args[0] && args[0].trim().startsWith("{") ? args[0] : fs.readFileSync(0, "utf8"));
// Input that is not valid JSON is bad input: exit 2, nothing written.
const parseInput = (text) => { try { return JSON.parse(text); } catch (e) { die(2, cmd + ": input is not valid JSON (" + e.message + ")"); } };

function validateRaise(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return "raise: input must be a JSON object";
  for (const k of Object.keys(d)) if (!ALLOWED.has(k)) return "unknown field " + k + " (allowed: " + [...ALLOWED].join(", ") + ")";
  const linkText = typeof d.link === "string" ? d.link.trim() : d.link;
  let link = null;
  if (linkText != null) {
    if (typeof linkText !== "string" || !linkText) link = { error: "link must be a non-blank string (a PR or issue URL) or left out" };
    else link = parseLink("link", linkText);
  }
  const ref = bareRef(d.card_ref);
  const cardRef = !ref && typeof d.card_ref === "string" ? parseLink("card_ref", d.card_ref) : null;
  const lawError = lawQError(d, link, cardRef);
  if (lawError) return "raise: " + lawError;
  const evidenceError = linkError(linkText, ref, link, cardRef);
  if (evidenceError) return "raise: " + evidenceError;
  if (linkText == null) delete d.link;
  else d.link = linkText;
  if (d.link && !d.card_ref) d.card_ref = d.link;
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(d.id || "")) return "id must be lowercase-kebab, 3-81 chars";
  if (!d.question || !d.what_happens_after) return "need question and what_happens_after in plain words";
  if (!Array.isArray(d.options) || !d.options.length) return "need at least one option";
  const ids = d.options.map((o) => o?.id);
  if (d.options.some((o) => !o?.id || !o.label) || new Set(ids).size !== ids.length || ids.includes("custom")) return "options need unique id+label; 'custom' is reserved";
  for (const k of ["multiSelect", "allowCustom"]) if (k in d && typeof d[k] !== "boolean") return k + " must be true or false";
  if ("details" in d) { const e = detailsError(d.details); if (e) return e; }
  if ("priority" in d && !isPriority(d.priority)) return "priority must be high, medium or low";
  if (typeof d.blocking !== "boolean") return "blocking is required: true only if a named open PR, merge or task cannot move until this is answered, and then blocks names it; else false";
  if (d.blocking && "priority" in d && d.priority !== "high") return "blocking cards are always high priority: drop priority or pass \"high\" (got \"" + d.priority + "\")";
  if (d.blocking && (!hasBlocks(d) || d.blocks.trim().length > 200)) return "blocking:true needs \"blocks\" (1 to 200 chars) naming the work it blocks: " + BLOCKS_RULE;
  if (!d.blocking && "blocks" in d) return "blocks is only for blocking:true cards: " + BLOCKS_RULE;
  if (d.blocking) { d.priority = "high"; d.blocks = d.blocks.trim(); }
  const problems = storedProblems(d);
  if (problems.length) return problems.join("\nab: ");
  d.context = d.context.trim();
  d.title = d.title.trim();
  return null;
}

if (cmd === "raise" || cmd === "lint-card") {
  let d, error;
  try { d = JSON.parse(args[0] ?? fs.readFileSync(0, "utf8")); }
  catch { error = "raise: input is not valid JSON"; }
  error ??= validateRaise(d);
  if (cmd === "lint-card") {
    const message = error?.replace(/^raise: /, "");
    const result = error
      ? { ok: false, ...(message.startsWith(LAW_Q) ? { law: "q" } : {}), error: message }
      : { ok: true };
    fs.writeSync(1, JSON.stringify(result) + "\n");
    process.exit(error ? 2 : 0);
  }
  if (error) die(2, error);
  const { title } = d;
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
    link: d.link ?? d.card_ref, decision_id: d.id, priority: priorityOf(d), blocking: d.blocking, blocks: d.blocks ?? null,
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
  // others: someone else's PR involving User. Missing means []; each item is {title, author, who, link} plus the PR fields.
  const others = g.others ?? [];
  if (!Array.isArray(others)) die(2, "glance.others must be an array");
  const OTHER_KEYS = ["title", "author", "who", "link"];
  // base, head and hot are optional on every PR item (waiting and others).
  const prFields = (o, at) => {
    for (const k of ["base", "head"]) if (k in o && (typeof o[k] !== "string" || !o[k].trim())) die(2, at + "." + k + " must be a non-blank string (a branch name)");
    if ("hot" in o && typeof o.hot !== "boolean") die(2, at + ".hot must be true or false");
    for (const k of ["hot_by", "hot_at"]) if (k in o && (typeof o[k] !== "string" || !o[k].trim())) die(2, at + "." + k + " must be a non-blank string");
  };
  others.forEach((o, n) => {
    const at = "glance.others[" + n + "]";
    if (!o || typeof o !== "object" || Array.isArray(o)) die(2, at + " must be an object {title, author, who, link}");
    for (const k of Object.keys(o)) if (![...OTHER_KEYS, ...PR_KEYS].includes(k)) die(2, at + " has unknown key " + k);
    for (const k of OTHER_KEYS) if (typeof o[k] !== "string" || !o[k].trim()) die(2, at + "." + k + " must be a non-blank string");
    if (!/^https?:\/\//.test(o.link)) die(2, at + ".link must start with http:// or https://");
    prFields(o, at);
  });
  g.waiting.forEach((w, n) => { if (w && typeof w === "object") prFields(w, "glance.waiting[" + n + "]"); });
  lock(); const f = load();
  // A routine refresh must not wipe hot markers: an item without a hot key keeps hot:true if its link was hot.
  const hotLinks = new Set([...(f.b.glance?.waiting ?? []), ...(f.b.glance?.others ?? [])].filter((x) => x?.hot === true && x.link).map((x) => x.link));
  // The hot map (ab hot / ab unhot) wins over both: an explicit unhot sticks against a glance that re-hots the PR,
  // an explicit hot against one that leaves it out.
  const marks = f.b.hot && typeof f.b.hot === "object" ? f.b.hot : {};
  for (const x of [...g.waiting, ...others]) {
    if (!x || typeof x !== "object") continue;
    const m = Object.hasOwn(marks, prKey(x.link) ?? "") ? marks[prKey(x.link)] : null;
    if (m) applyMark(x, m);
    else if (!("hot" in x) && hotLinks.has(x.link)) x.hot = true;
  }
  f.b.glance = { waiting: g.waiting, tickets: g.tickets, others };
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "glance", live });
  console.log(JSON.stringify({ ok: true, live, counts: { waiting: g.waiting.length, tickets: g.tickets.length, others: others.length } }));
} else if (cmd === "hot" || cmd === "unhot") {
  const usage = "usage: ab " + cmd + " <pr-url> [--by name]";
  const hasBy = args.includes("--by"), by = hasBy ? flag(args, "--by") : "cli";
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(by ?? "")) die(2, cmd + ": --by must be 1 to 32 letters, digits, _ or -");
  if (args.length !== 1) die(2, usage);
  const c = canonicalPr(args[0]);
  if (!c) die(2, usage + " (" + GH_FORM + ")");
  if (c.error) die(2, cmd + ": " + c.error);
  const url = c.url, hot = cmd === "hot";
  lock(); const f = load();
  // Glance PRs with that link (canonical match), waiting (the user’s PRs) first, then others; the first is reported.
  const hits = ["waiting", "others"].flatMap((k) => (f.b.glance?.[k] ?? []).filter((x) => x && typeof x === "object" && prKey(x.link) === url).map((item) => ({ k, item })));
  const section = hits[0]?.k ?? null, item = hits[0]?.item ?? null;
  const prev = f.b.hot?.[url];
  if (prev && prev.hot === hot) {
    const live = await waitServed((b) => b.hot?.[url]?.hot === hot);
    console.log(JSON.stringify({ ok: true, live, section, item, mark: prev, status: "unchanged" }));
    process.exit(0);
  }
  const mark = { hot, by, at: new Date().toISOString() };
  f.b.hot = { ...(f.b.hot && typeof f.b.hot === "object" ? f.b.hot : {}), [url]: mark };
  for (const h of hits) applyMark(h.item, mark);
  const u = save(f, f.b);
  // The event log only after board.ts is written; a failed append warns but never undoes the write.
  try {
    fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
    fs.appendFileSync(EVENTS_FILE, JSON.stringify({ at: mark.at, kind: cmd, url, by }) + "\n");
  } catch (e) { console.error("ab: warning: " + cmd + " written to board.ts but not to the event log " + EVENTS_FILE + ": " + e.message); }
  const live = await waitServed((b) => b.updated_at === u);
  log({ op: cmd, link: url, section, live });
  console.log(JSON.stringify({ ok: true, live, section, item, mark, status: "changed" }));
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
  // The to-do list: a todos.ts that is there but does not load (missing markers, bad JSON) is a problem.
  if (fs.existsSync(TODOS_FILE)) { const td = loadTodos(true); if (td.error) problems.push(td.error); }
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
} else if (cmd === "todo-add") {
  const { v, no } = todoInput(cmd, ["id", "name", "description", "priority", "due", "parent_id", "quick"]);
  if (!("name" in v) && !("quick" in v)) no("give name or quick, like {\"quick\":\"call the vendor p1\"}");
  // quick goes through the Board's own parser; explicit fields win over what it finds.
  let q = {};
  if ("quick" in v) {
    if (typeof v.quick !== "string" || !v.quick.trim()) no("quick must be a non-blank string");
    q = (await appModule("quickadd.ts")).parseQuickAdd(v.quick);
    if (!("name" in v) && !q.name) no("quick add needs a name besides the priority, like \"call the vendor p1\"");
  }
  const name = v.name ?? q.name, priority = v.priority ?? q.priority ?? "medium", due = v.due;
  const e = todoNameError(name) || ("description" in v ? textError("description", v.description) : null) || priorityError(priority) || (due === undefined ? null : dueError(due));
  if (e) no(e);
  if ("id" in v && (typeof v.id !== "string" || !TODO_ID.test(v.id))) no("id must be lowercase kebab, 3-81 chars");
  lock(TODOS_FILE + ".lock"); const f = loadTodos();
  const items = f.t.items;
  if ("parent_id" in v) { const pe = parentError(items, v.parent_id); if (pe) no(pe); }
  const taken = new Set(items.map((x) => x.id));
  if ("id" in v && taken.has(v.id)) no("id " + v.id + " is already a to-do");
  let id = v.id;
  while (!id || taken.has(id)) id = slugify(name.trim()) + "-" + randomBytes(3).toString("hex");
  const now = new Date().toISOString();
  const todo = todoOrder({ id, name: name.trim(), description: v.description?.trim() || undefined, priority, due, parent_id: v.parent_id, comments: [], created_at: now, updated_at: now });
  items.push(todo); saveTodos(f, f.t); unlock();
  log({ op: cmd, id });
  console.log(JSON.stringify({ ok: true, todo }));
} else if (cmd === "todo-update") {
  const { v, no } = todoInput(cmd, ["id", "name", "description", "priority", "due", "parent_id"]);
  if (Object.keys(v).length < 2) no("give at least one of name, description, priority, due, parent_id to change");
  const e = ("name" in v ? todoNameError(v.name) : null) || ("description" in v && v.description !== null ? textError("description", v.description) : null)
    || ("priority" in v ? priorityError(v.priority) : null) || ("due" in v && v.due !== null ? dueError(v.due) : null);
  if (e) no(e);
  lock(TODOS_FILE + ".lock"); const f = loadTodos();
  const k = f.t.items.findIndex((x) => x.id === v.id), t = findTodo(f, cmd, v.id);
  if ("parent_id" in v && v.parent_id !== null) { const pe = parentError(f.t.items, v.parent_id, t); if (pe) no(pe); }
  // null (or a blank description) clears a field.
  const next = { ...t, updated_at: new Date().toISOString() };
  if ("name" in v) next.name = v.name.trim();
  if ("description" in v) next.description = v.description?.trim() || undefined;
  if ("priority" in v) next.priority = v.priority;
  if ("due" in v) next.due = v.due ?? undefined;
  if ("parent_id" in v) next.parent_id = v.parent_id ?? undefined;
  f.t.items[k] = todoOrder(next); saveTodos(f, f.t); unlock();
  log({ op: cmd, id: v.id, fields: Object.keys(v).filter((x) => x !== "id") });
  console.log(JSON.stringify({ ok: true, todo: f.t.items[k] }));
} else if (cmd === "todo-comment") {
  const authorFlag = flag(args, "--author");
  const { v, no } = todoInput(cmd, ["id", "text", "author"]);
  if (authorFlag !== undefined) { if ("author" in v) no("give the author once: --author or \"author\", not both"); v.author = authorFlag; }
  if (typeof v.text !== "string" || !v.text.trim()) no("text must be a non-blank string");
  const te = textError("text", v.text); if (te) no(te);
  if ("author" in v && (typeof v.author !== "string" || !v.author.trim() || v.author.trim().length > 100)) no("author must be a non-blank string of at most 100 chars");
  lock(TODOS_FILE + ".lock"); const f = loadTodos();
  const t = findTodo(f, cmd, v.id);
  const now = new Date().toISOString();
  const comment = { id: "c-" + randomBytes(4).toString("hex"), text: v.text.trim(), author: v.author?.trim() ?? "bot", at: now };
  t.comments = [...(Array.isArray(t.comments) ? t.comments : []), comment]; t.updated_at = now;
  saveTodos(f, f.t); unlock();
  log({ op: cmd, id: v.id, comment: comment.id });
  console.log(JSON.stringify({ ok: true, comment, todo: t }));
} else if (cmd === "todo-done" || cmd === "todo-reopen") {
  const { v } = todoInput(cmd, ["id"]);
  lock(TODOS_FILE + ".lock"); const f = loadTodos();
  const k = f.t.items.findIndex((x) => x.id === v.id), t = findTodo(f, cmd, v.id);
  const done = cmd === "todo-done";
  // Completing a parent leaves its subtasks as they are.
  if (!!t.done_at === done) { console.log(JSON.stringify({ ok: true, status: done ? "already-done" : "already-open", todo: t })); process.exit(0); }
  const now = new Date().toISOString();
  f.t.items[k] = todoOrder({ ...t, updated_at: now, done_at: done ? now : undefined });
  saveTodos(f, f.t); unlock();
  log({ op: cmd, id: v.id });
  console.log(JSON.stringify({ ok: true, status: done ? "done" : "reopened", todo: f.t.items[k] }));
} else if (cmd === "todo-list") {
  const view = flag(args, "--view") ?? "all";
  if (args.length || !["today", "upcoming", "done", "all"].includes(view)) die(2, "todo-list: usage: ab todo-list [--view today|upcoming|done|all]");
  const items = loadTodos().t.items;
  const out = view === "all" ? items : (await appModule("todos.ts")).cliTodoList(items, view, new Date());
  console.log(JSON.stringify(out));
} else {
  die(2, "usage: ab raise|lint-card|answer|clear|restore|priority|glance|hot|unhot|open|check|lint|backfill-stamps|backfill-titles|project-refresh|todo-add|todo-update|todo-comment|todo-done|todo-reopen|todo-list (see header of " + process.argv[1] + ")");
}
