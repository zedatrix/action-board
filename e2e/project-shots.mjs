// Project tab check against the RUNNING dev server (default http://127.0.0.1:8085, AB_URL to change).
// Screenshots: runs/project-tab.png (desktop), runs/project-tab-360.png (360px wide), runs/board-tab.png (default tab).
// Then a live round trip on the real app/src/data/project.ts, only through bin/ab.mjs project-refresh and only with the
// counts already in the file: once with updated_at = now (the open page must show the new time with no reload, via
// Vite HMR), then once with the file's own updated_at, which must leave project.ts byte for byte as it was.
// Never touches board.ts or .env files. Prints one PASS/FAIL line per step.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL_ = process.env.AB_URL || "http://127.0.0.1:8085";
const CHROME =
  process.env.CHROME_PATH ||
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const AB = join(ROOT, "bin/ab.mjs");
const PROJECT = join(ROOT, "app/src/data/project.ts");

const results = [];
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
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const readProject = () => {
  const s = readFileSync(PROJECT, "utf8");
  const A = "/* PROJECT-JSON-START */";
  return { text: s, p: JSON.parse(s.slice(s.indexOf(A) + A.length, s.indexOf("/* PROJECT-JSON-END */"))) };
};
// What the page should show, from the file as it is now: the tab title, the row count and the summed totals.
const start = readProject().p;
const TITLE = start.title;
const ROW_COUNT = start.milestones.length;
const TOTALS = ["done", "in_progress", "left", "total"].map((k) => start.milestones.reduce((n, m) => n + m[k], 0)).join(",");
const ZONE = process.env.ACTION_BOARD_TIMEZONE || "America/New_York";
const refresh = (p, updated_at) =>
  promisify(execFile)(process.execPath, [AB, "project-refresh", JSON.stringify({
    updated_at,
    milestones: p.milestones.map(({ id, done, in_progress, left, total }) => ({ id, done, in_progress, left, total })),
  })]).then((r) => JSON.parse(r.stdout));

// The table as the page shows it: body row count, the total row's numbers, and the "Last updated" time.
const tableState = (page) =>
  page.evaluate(() => {
    const panel = document.getElementById("panel-project");
    return {
      lineCount: panel.querySelectorAll("tbody tr").length,
      totals: [...panel.querySelectorAll("tfoot td")].map((td) => td.textContent).join(","),
      totalBold: getComputedStyle(panel.querySelector("tfoot td")).fontWeight,
      time: panel.querySelector("time")?.textContent,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      tableOverflow: panel.querySelector(".project-wrap").scrollWidth - panel.querySelector(".project-wrap").clientWidth,
    };
  });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
const page = await browser.newPage();
mkdirSync(join(ROOT, "runs"), { recursive: true });
const shot = (name) => page.screenshot({ path: join(ROOT, "runs", name), fullPage: true });

await step("project tab at #project, desktop", async () => {
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${URL_}/#project`, { waitUntil: "load" });
  await page.waitForSelector("#panel-project:not([hidden]) table");
  const sel = await page.$eval('[role="tab"][aria-selected="true"]', (t) => t.textContent);
  const s = await tableState(page);
  assert(sel === TITLE, `selected tab ${sel}`);
  assert(s.lineCount === ROW_COUNT && s.totals === TOTALS, `lines ${s.lineCount}, totals ${s.totals}`);
  assert(Number(s.totalBold) >= 700, `total row weight ${s.totalBold}`);
  await shot("project-tab.png");
  return `${s.lineCount} lines, All milestones ${s.totals}, ${s.time}`;
});

await step("project tab at 360px wide", async () => {
  await page.setViewport({ width: 360, height: 800 });
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#panel-project:not([hidden]) table");
  const s = await tableState(page);
  assert(s.lineCount === ROW_COUNT && s.totals === TOTALS, `lines ${s.lineCount}, totals ${s.totals}`);
  assert(s.overflow <= 0, `page scrolls sideways by ${s.overflow}px`);
  assert(s.tableOverflow <= 0, `table scrolls sideways by ${s.tableOverflow}px`);
  await shot("project-tab-360.png");
  return "no sideways scroll on the page or in the table";
});

await step("board tab is the default (no hash) and still renders", async () => {
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(URL_, { waitUntil: "load" });
  await page.waitForSelector("#panel-board:not([hidden]) .kicker");
  const info = await page.evaluate(() => ({
    sel: document.querySelector('[role="tab"][aria-selected="true"]').textContent,
    kicker: document.querySelector("#panel-board .kicker").textContent,
    panels: document.querySelectorAll("#panel-board .panel").length,
    projectHidden: document.getElementById("panel-project").hidden,
    hash: location.hash,
  }));
  assert(info.sel === "Board" && info.projectHidden && info.hash === "", JSON.stringify(info));
  assert(/Needs you/.test(info.kicker) && info.panels === 3, JSON.stringify(info));
  await shot("board-tab.png");
  return `${info.kicker.replace(/\s+/g, " ")}, ${info.panels} glance panels`;
});

await step("clicking the project tab sets #project; a reload keeps it", async () => {
  await page.click("#tab-project");
  assert((await page.evaluate(() => location.hash)) === "#project", "hash not set");
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#panel-project:not([hidden]) table");
});

const before = readProject();
await step("live: project-refresh on the real project.ts shows with no reload", async () => {
  await page.evaluate(() => (window.__sameDocument = true));
  const now = new Date();
  now.setSeconds(0, 0);
  const out = await refresh(before.p, now.toISOString());
  assert(out.ok && Object.values(out.totals).join(",") === TOTALS, JSON.stringify(out));
  const t0 = Date.now();
  const want = await page.evaluate((iso, timeZone) => {
    const f = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    return f.format(new Date(iso)).replace(/[  ]/g, " ");
  }, out.updated_at, ZONE);
  await page.waitForFunction((w) => document.querySelector("#panel-project time")?.textContent === w, { timeout: 5000 }, want);
  const ms = Date.now() - t0;
  assert(await page.evaluate(() => window.__sameDocument === true), "the page reloaded");
  const s = await tableState(page);
  assert(s.totals === TOTALS, `totals ${s.totals}`);
  return `"${want}" shown after ${ms}ms, same document, totals ${s.totals}`;
});

await step("live: project-refresh with the file's own data round-trips byte for byte", async () => {
  const out = await refresh(before.p, before.p.updated_at);
  assert(out.ok && out.updated_at === before.p.updated_at, JSON.stringify(out));
  assert(readProject().text === before.text, "project.ts differs from before");
  await page.waitForFunction((w) => document.querySelector("#panel-project time")?.getAttribute("datetime") === w, { timeout: 5000 }, before.p.updated_at);
  const s = await tableState(page);
  assert(s.lineCount === ROW_COUNT && s.totals === TOTALS, `lines ${s.lineCount}, totals ${s.totals}`);
  assert(await page.evaluate(() => window.__sameDocument === true), "the page reloaded");
  await shot("project-tab.png");
  return `${JSON.stringify(out)}; page shows ${s.totals}, ${s.time}`;
});

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`passed ${results.length - failed} failed ${failed}`);
process.exit(failed ? 1 : 0);
