// Headless check of one app answer, or one "Message your assistant" note, against an already-running board (for example the
// board started by start.sh). Opens the board in a fresh Chrome profile and reports how the webhook POST
// was delivered: the browser's direct POST to the webhook, or the /__ab/webhook dev-server fallback.
//
//   node e2e/webhook-check.mjs --url http://127.0.0.1:8085 --id <decision_id> [--option <option_id>]
//   node e2e/webhook-check.mjs --url http://127.0.0.1:8085 --message <item_id> --text <text> [--section <section>]
//   node e2e/webhook-check.mjs --url http://127.0.0.1:8085 --message-title <title> --text <text> [--section <section>]
//
// Answer mode clicks an option on one card. Message mode opens the composer on the item whose data-item-id
// (or title) matches, types --text, presses Send and waits for the stored message to be delivered or failed.
// --section (decision, waiting, others, tickets) picks between items that share an item_id; default: first match.
//
// The webhook URL and Authorization value are secrets. This script never prints a URL other than the
// board origin (and the item_id it was asked about, which is board data), nor headers, bodies, env values
// or the stored payload. Prints one JSON line. Exit 0 if delivered, 1 otherwise.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import puppeteer from "puppeteer-core";

const STORAGE_KEY = "action-board:app-answers";
const MESSAGES_KEY = "action-board:messages";
const FALLBACK_PATH = "/__ab/webhook";
const BOARD_PATH = "/__ab/board";
const WAIT_MS = 20000;
const CHROME =
  process.env.CHROME_PATH ||
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");

const USAGE = [
  "Usage: node e2e/webhook-check.mjs --url http://127.0.0.1:8085 --id <decision_id> [--option <option_id>]",
  "       node e2e/webhook-check.mjs --url http://127.0.0.1:8085 --message <item_id> --text <text> [--section <section>]",
  "       node e2e/webhook-check.mjs --url http://127.0.0.1:8085 --message-title <title> --text <text> [--section <section>]",
].join("\n");

const { values: opts } = parseArgs({
  options: {
    url: { type: "string" },
    id: { type: "string" },
    option: { type: "string" },
    message: { type: "string" },
    "message-title": { type: "string" },
    text: { type: "string" },
    section: { type: "string" },
  },
});
const messageMode = opts.message !== undefined || opts["message-title"] !== undefined;
if (!opts.url || (messageMode ? !opts.text?.trim() || (opts.message && opts["message-title"]) : !opts.id)) {
  console.error(USAGE);
  process.exit(2);
}
const boardUrl = new URL(opts.url);
const ORIGIN = boardUrl.origin;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBoard = (u) => {
  try {
    return new URL(u).origin === ORIGIN;
  } catch {
    return false;
  }
};
// Replaces every http(s) URL that is not on the board origin with "<webhook>".
const mask = (text) => String(text).replace(/https?:\/\/[^\s'"`<>()]+/g, (u) => (isBoard(u) ? u : "<webhook>"));

const result = messageMode
  ? {
      item_id: opts.message ?? null,
      item_section: opts.section ?? null,
      status: null,
      attempts: 0,
      last_http: null,
      direct: { attempted: false, ok: false, http: null, error: null },
      fallback: { attempted: false, http: null },
      delivered_via: null,
      item_still_present: false,
      sent_shown: false,
      cors_console_messages: [],
    }
  : {
      decision_id: opts.id,
      card_hidden: false,
      status: null,
      attempts: 0,
      last_http: null,
      direct: { attempted: false, ok: false, http: null, error: null },
      fallback: { attempted: false, http: null },
      delivered_via: null,
      cors_console_messages: [],
      header_marker: null,
    };

// Always a throwaway profile, never the user's own Chrome profile or its localStorage.
const profile = mkdtempSync(join(tmpdir(), "ab-webhook-check-"));
let browser;
let error = null;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, async () => {
    await browser?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
    process.exit(1);
  });
}

// Network: per request, only kind, method, failure text and status. Never the URL, headers or body.
function trackNetwork(page) {
  const requests = new Map();
  page.on("request", (req) => {
    const url = req.url();
    if (isBoard(url)) {
      if (new URL(url).pathname === FALLBACK_PATH) requests.set(req, { kind: "fallback", method: req.method(), failed: false, error: null, http: null });
    } else if (["fetch", "xhr"].includes(req.resourceType())) {
      requests.set(req, { kind: "direct", method: req.method(), failed: false, error: null, http: null });
    }
  });
  page.on("response", (res) => {
    const rec = requests.get(res.request());
    if (rec) rec.http = res.status();
  });
  page.on("requestfailed", (req) => {
    const rec = requests.get(req);
    if (rec) Object.assign(rec, { failed: true, error: req.failure()?.errorText ?? "failed" });
  });
  page.on("console", (msg) => {
    const text = msg.text();
    if (/CORS|Access-Control/i.test(text)) result.cors_console_messages.push(mask(text));
  });
  return requests;
}

function summarizeNetwork(requests) {
  const direct = [...requests.values()].filter((r) => r.kind === "direct");
  const fallback = [...requests.values()].filter((r) => r.kind === "fallback");
  const okDirect = direct.find((r) => !r.failed && r.http >= 200 && r.http < 300);
  const lastDirect = okDirect ?? direct.at(-1);
  if (lastDirect) {
    result.direct = { attempted: true, ok: Boolean(okDirect), http: lastDirect.http, error: lastDirect.error };
  }
  if (fallback.length) result.fallback = { attempted: true, http: fallback.at(-1).http };
  if (result.status === "delivered") result.delivered_via = okDirect ? "direct" : fallback.length ? "fallback" : null;
}

const readMarker = (page) => page.$eval(".marker", (e) => e.textContent).catch(() => null);

// Polls `read` (status, attempts, last_http only) until delivered or failed, or no webhook is set up.
async function waitForDelivery(page, read) {
  const end = Date.now() + WAIT_MS;
  for (;;) {
    const rec = await read();
    if (rec) Object.assign(result, rec);
    if (rec && (rec.status === "delivered" || rec.status === "failed")) break;
    // Without a webhook URL it stays pending forever; no point waiting the full 20s.
    if (/not set up/i.test((await readMarker(page)) ?? "")) break;
    if (Date.now() > end) break;
    await sleep(200);
  }
  await sleep(300); // let the last request/console events land
}

async function launch() {
  const args = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args });
  return browser.newPage();
}

async function checkAnswer() {
  // The option buttons carry only labels, so map --option to a button position via the board feed.
  const board = await (await fetch(new URL(BOARD_PATH, ORIGIN))).json();
  const decision = board.decisions?.find((d) => d.id === opts.id);
  if (!decision) throw new Error(`decision ${opts.id} is not on the board`);
  if (decision.answer) throw new Error(`decision ${opts.id} is already answered in board.ts`);
  const optionIndex = opts.option ? decision.options.findIndex((o) => o.id === opts.option) : 0;
  if (optionIndex < 0) throw new Error(`decision ${opts.id} has no option ${opts.option}`);

  const page = await launch();
  const requests = trackNetwork(page);
  await page.goto(boardUrl.href, { waitUntil: "domcontentloaded" });
  const cardSel = `article[data-decision-id=${JSON.stringify(opts.id)}]`;
  await page.waitForSelector(cardSel, { timeout: WAIT_MS });

  const buttons = await page.$$(`${cardSel} .options button`);
  if (!buttons[optionIndex]) throw new Error(`option button ${optionIndex + 1} not found on the card`);
  await buttons[optionIndex].click();
  if (decision.multiSelect) await page.click(`${cardSel} .submit-row button`);

  await waitForDelivery(page, () =>
    page.evaluate(
      (key, id) => {
        try {
          const r = JSON.parse(localStorage.getItem(key) ?? "{}")[id];
          return r ? { status: r.status, attempts: r.attempts, last_http: r.last_http } : null;
        } catch {
          return null;
        }
      },
      STORAGE_KEY,
      opts.id,
    ),
  );

  result.card_hidden = (await page.$(cardSel)) === null;
  result.header_marker = await readMarker(page);
  summarizeNetwork(requests);
}

async function checkMessage() {
  const page = await launch();
  const requests = trackNetwork(page);
  await page.goto(boardUrl.href, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-item-id]", { timeout: WAIT_MS });

  // Index of the first item root matching --message (item_id) or --message-title, and --section if given.
  const find = (want) =>
    page.$$eval(
      "[data-item-id]",
      (roots, want) => {
        const titleOf = (root) => {
          const t = root.querySelector(".question, .item .title");
          if (!t) return "";
          return [...t.childNodes]
            .filter((n) => !(n.nodeType === 1 && n.classList.contains("tid")))
            .map((n) => n.textContent)
            .join("")
            .trim();
        };
        const i = roots.findIndex(
          (r) =>
            (want.section === null || r.dataset.itemSection === want.section) &&
            (want.id !== null ? r.dataset.itemId === want.id : titleOf(r) === want.title),
        );
        return i < 0 ? null : { index: i, item_id: roots[i].dataset.itemId, item_section: roots[i].dataset.itemSection };
      },
      want,
    );
  const want = { id: opts.message ?? null, title: opts["message-title"]?.trim() ?? null, section: opts.section ?? null };
  // The board may still be on the bundled copy for a moment; give the live feed a chance to land.
  let target = null;
  for (const end = Date.now() + 5000; !target && Date.now() < end; await sleep(200)) target = await find(want);
  if (!target) throw new Error(`no board item matches ${want.id !== null ? `item_id ${want.id}` : `title "${want.title}"`}${want.section ? ` in ${want.section}` : ""}`);
  Object.assign(result, { item_id: target.item_id, item_section: target.item_section });

  const root = (await page.$$("[data-item-id]"))[target.index];
  await (await root.$(".msg-btn")).click();
  const field = await root.waitForSelector("textarea", { timeout: WAIT_MS });
  await field.type(opts.text);
  await (await root.$('.composer button[type="submit"]')).click();

  // Fresh profile: the newest message about this item is the one just sent. Only status fields are read.
  await waitForDelivery(page, () =>
    page.evaluate(
      (key, id, section) => {
        try {
          const recs = Object.values(JSON.parse(localStorage.getItem(key) ?? "{}")).filter(
            (r) => r?.payload?.item_id === id && r.payload.item_section === section,
          );
          const r = recs.sort((a, b) => (a.payload.sent_at < b.payload.sent_at ? 1 : -1))[0];
          return r ? { status: r.status, attempts: r.attempts, last_http: r.last_http } : null;
        } catch {
          return null;
        }
      },
      MESSAGES_KEY,
      target.item_id,
      target.item_section,
    ),
  );

  const after = await page.$$eval(
    "[data-item-id]",
    (roots, t) => {
      const r = roots.find((x) => x.dataset.itemId === t.item_id && x.dataset.itemSection === t.item_section);
      return { present: Boolean(r), sent: /^Sent to .+ · /.test(r?.querySelector(".msg-status")?.textContent ?? "") };
    },
    target,
  );
  result.item_still_present = after.present;
  result.sent_shown = after.sent;
  summarizeNetwork(requests);
}

try {
  await (messageMode ? checkMessage() : checkAnswer());
} catch (err) {
  error = mask(err?.message ?? err);
} finally {
  await browser?.close().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true });
}

console.log(JSON.stringify(error ? { ...result, error } : result));
process.exit(result.status === "delivered" ? 0 : 1);
