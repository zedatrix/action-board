// Live-update check: temp copy of app/ + Vite dev server on 127.0.0.1 + headless Chrome. Edits the copy's
// board.ts with bin/ab.mjs (raise, answer) while the page is open and measures how long each change takes to
// show, with no reload, no HMR of App.tsx, and a typed but unsent free-text answer left intact.
// Also covers a background tab, a reload, and the polling fallback with /__ab/events blocked.
// Never touches the real app/src/data/board.ts or app/.env.local. Prints one PASS/FAIL line per step.
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = join(ROOT, "app");
const CHROME =
  process.env.CHROME_PATH ||
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const LIMIT_MS = 2000;

const { createServer: createVite } = await import(pathToFileURL(join(APP_DIR, "node_modules/vite/dist/node/index.js")).href);

const AB = join(ROOT, "bin/ab.mjs");

delete process.env.ACTION_BOARD_WEBHOOK_URL;
delete process.env.ACTION_BOARD_WEBHOOK_AUTH;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const results = [];
const delays = [];
async function step(label, fn) {
  try {
    const note = await fn();
    results.push(true);
    console.log(`PASS ${label}${note ? ` -- ${note}` : ""}`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL ${label} -- ${err?.message ?? err}`);
  }
}

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

// realpath: on macOS tmpdir() is under /var, a symlink to /private/var, and Vite's fs.allow compares real paths.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ab-live-")));
const copy = join(tmp, "app");
// Top-level app/ entries never copied: every .env* file (only the temp .env.local written below counts),
// build output, and the real app's logs.
const skip = new Set(["node_modules", "dist", ".delivery-log.jsonl", ".ab-log.jsonl", ".ab-cleared.jsonl"]);
const skipTop = (name) => name.startsWith(".env") || skip.has(name);
cpSync(APP_DIR, copy, { recursive: true, filter: (src) => !skipTop(src.slice(APP_DIR.length + 1).split("/")[0]) });
symlinkSync(join(APP_DIR, "node_modules"), join(copy, "node_modules"), "dir");
writeFileSync(join(copy, ".env.local"), "ACTION_BOARD_WEBHOOK_URL=\nACTION_BOARD_WEBHOOK_AUTH=\n");
const boardFile = join(copy, "src/data/board.ts");

// Runs bin/ab.mjs on the copy's board.ts against the temp Vite server (AB_URL, set once it listens), so
// raise also confirms the server serves the change (exit 3 if not). Async on purpose: Vite runs in this
// process, so a blocking call would stall the server ab is polling.
let abUrl;
const run = (args) => {
  const env = { ...process.env, AB_FILE: boardFile, AB_URL: abUrl };
  delete env.AB_NO_SERVER;
  return promisify(execFile)(process.execPath, [AB, ...args], { env });
};
// ab raise needs a card title and blocking; the title is stored on the board and shown bold at the top of the card.
const add = (d) => run(["raise", JSON.stringify(d)]);
const mark = (id, opt) => run(["answer", id, opt, "--by", "chat"]);
const decision = (id) => ({
  id,
  title: "Live board check card",
  card_ref: "PROJ-LIVE",
  context: "A throwaway card for the live board check. It measures how fast a raised card shows on the open page.",
  question: `[live] ${id}?`,
  what_happens_after: "Nothing real happens; this is the live check.",
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  blocking: false,
});

const port = await freePort();
const vite = await createVite({
  configFile: join(copy, "vite.config.ts"),
  root: copy,
  cacheDir: join(tmp, ".vite-cache"),
  logLevel: "info",
  server: { host: "127.0.0.1", port, strictPort: true, open: false, fs: { allow: [tmp, join(APP_DIR, "node_modules")] } },
});
const serverLog = [];
vite.config.logger.info = (m) => serverLog.push(String(m).replace(/\x1b\[[0-9;]*m/g, ""));
await vite.listen();
const url = `http://127.0.0.1:${port}/`;
abUrl = `http://127.0.0.1:${port}`;

const args = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args });

async function openPage({ blockEvents = false } = {}) {
  const page = await browser.newPage();
  const log = [];
  page.on("console", (m) => log.push(m.text()));
  page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
  let navigations = 0;
  page.on("framenavigated", (f) => f === page.mainFrame() && navigations++);
  const requests = { events: 0, board: 0 };
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (path === "/__ab/events") requests.events++;
    if (path === "/__ab/board") requests.board++;
  });
  if (blockEvents) {
    await page.setRequestInterception(true);
    page.on("request", (r) => (new URL(r.url()).pathname === "/__ab/events" ? r.abort() : r.continue()));
  }
  // Not networkidle: the /__ab/events stream stays open.
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".needs-you h2", { timeout: 20000 });
  await sleep(500); // let the stream (or the first poll) connect
  await page.evaluate(() => (window.__liveCheck = true));
  return { page, log, requests, navigations: () => navigations };
}

const cardIds = (page) => page.$$eval("article.card", (els) => els.map((e) => e.getAttribute("data-decision-id")));
const sameInstance = (page) => page.evaluate(() => window.__liveCheck === true);

// Starts a change and polls the DOM every 10ms until it shows. Returns the delay in ms, from the ab command's
// start to the DOM update; still waits for ab to exit and fails if it did not exit 0.
async function timed(page, apply, shown, what) {
  const t0 = Date.now();
  let err;
  const done = apply().catch((e) => (err = e));
  for (;;) {
    if (err) throw err;
    if (shown(await cardIds(page))) {
      const ms = Date.now() - t0;
      await done;
      if (err) throw err;
      return ms;
    }
    if (Date.now() - t0 > 10000) throw new Error(`${what} not shown after 10s`);
    await sleep(10);
  }
}

try {
  const { page, log, requests, navigations } = await openPage();
  const hmrBefore = serverLog.filter((l) => l.includes("hmr update")).length;

  await step("1. ab raise: card appears without reload", async () => {
    const ms = await timed(page, () => add(decision("live-a")), (ids) => ids.includes("live-a"), "live-a");
    delays.push({ change: "add live-a", ms });
    assert(ms < LIMIT_MS, `took ${ms}ms`);
    return `${ms}ms`;
  });

  await step("2. second add while open: also appears", async () => {
    const ms = await timed(page, () => add(decision("live-b")), (ids) => ids.includes("live-b"), "live-b");
    delays.push({ change: "add live-b", ms });
    assert(ms < LIMIT_MS, `took ${ms}ms`);
    return `${ms}ms`;
  });

  await step("3. ab answer (chat) on live-a: card leaves, typed text in live-b survives", async () => {
    const field = 'article.card[data-decision-id="live-b"] input[type="text"], article.card[data-decision-id="live-b"] textarea';
    await page.type(field, "typed but not sent");
    const ms = await timed(page, () => mark("live-a", "yes"), (ids) => !ids.includes("live-a"), "live-a removal");
    delays.push({ change: "mark live-a (chat)", ms });
    assert(ms < LIMIT_MS, `took ${ms}ms`);
    const value = await page.$eval(field, (e) => e.value);
    assert(value === "typed but not sent", `typed value was "${value}"`);
    assert(await page.$eval(field, (e) => e === document.activeElement), "typed field lost focus");
    return `${ms}ms, typed value and focus kept`;
  });

  await step("4. five more quick changes, each measured", async () => {
    for (let i = 0; i < 5; i++) {
      const id = `live-c${i}`;
      const ms = await timed(page, () => add(decision(id)), (ids) => ids.includes(id), id);
      delays.push({ change: `add ${id}`, ms });
      assert(ms < LIMIT_MS, `${id} took ${ms}ms`);
    }
    return delays.slice(-5).map((d) => `${d.ms}ms`).join(", ");
  });

  await step("5. no reload, no HMR of App.tsx for board.ts edits, no page errors", async () => {
    assert(await sameInstance(page), "page reloaded");
    assert(navigations() === 1, `navigations: ${navigations()}`);
    const hmr = serverLog.filter((l) => l.includes("hmr update")).length - hmrBefore;
    assert(hmr === 0, `server sent ${hmr} HMR updates`);
    const bad = log.filter((l) => /hot updated|page reload|hmr invalidate|pageerror|Uncaught/i.test(l));
    assert(bad.length === 0, `console: ${bad.join(" | ")}`);
    assert(requests.events === 1, `/__ab/events requests: ${requests.events}`);
    assert(requests.board === 0, `/__ab/board was polled ${requests.board} times`);
    return "same page, 0 HMR updates, 0 reload/invalidate/error console lines, 1 stream, 0 polls";
  });

  await step("6. background tab (document.hidden) still updates", async () => {
    const other = await browser.newPage();
    await other.bringToFront();
    const hidden = await page.evaluate(() => document.hidden);
    assert(hidden, "board tab is not hidden");
    const ms = await timed(page, () => add(decision("live-bg")), (ids) => ids.includes("live-bg"), "live-bg");
    delays.push({ change: "add live-bg (hidden tab)", ms });
    await other.close();
    await page.bringToFront();
    assert(ms < LIMIT_MS, `took ${ms}ms`);
    return `${ms}ms while hidden`;
  });

  await step("7. reload serves the latest board.ts", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".needs-you h2", { timeout: 20000 });
    const ids = await cardIds(page);
    assert(ids.includes("live-bg") && !ids.includes("live-a"), `cards after reload: ${ids}`);
    return `${ids.length} cards`;
  });
  await page.close();

  await step("8. /__ab/events blocked: polling /__ab/board picks up a change", async () => {
    const p = await openPage({ blockEvents: true });
    const ms = await timed(p.page, () => add(decision("live-poll")), (ids) => ids.includes("live-poll"), "live-poll");
    delays.push({ change: "add live-poll (SSE blocked, polling)", ms });
    assert(await sameInstance(p.page), "page reloaded");
    await p.page.close();
    assert(ms < 2000 + 500, `took ${ms}ms`);
    assert(p.requests.board > 0, "no /__ab/board polls");
    return `${ms}ms via polling (${p.requests.board} polls, ${p.requests.events} blocked stream attempts)`;
  });
} finally {
  await browser.close();
  await vite.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log("\n== measured delays (ab command start to DOM updated) ==");
for (const d of delays) console.log(`${String(d.ms).padStart(5)}ms  ${d.change}`);
const sse = delays.filter((d) => !d.change.includes("polling")).map((d) => d.ms).sort((a, b) => a - b);
if (sse.length) console.log(`SSE path: min ${sse[0]}ms, median ${sse[Math.floor(sse.length / 2)]}ms, max ${sse.at(-1)}ms over ${sse.length} changes`);
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
