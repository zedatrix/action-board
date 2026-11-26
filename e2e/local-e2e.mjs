// Local end-to-end check: temp copy of app/ + Vite dev server + headless Chrome + mock webhook receivers.
// For each receiver it answers a card in the browser and reports how the answer reached the receiver
// (direct browser POST, or the /__ab/webhook dev-server fallback). Then it edits the copy's board.ts with
// bin/ab.mjs (raise, answer) and checks the page updates live (/__ab/events) without a reload. Last it clicks
// "Explain this better" on a card and checks the decision.clarify POST, Rewording..., and that a re-raise clears it.
// Then it taps priority levels on that card and checks the queue order, the High/Medium/Low sections and the copy's board.ts (via /__ab/priority).
// Last it taps "Not relevant anymore" on a new card E: the decision.not_relevant POST, then the clear (via /__ab/clear) from the
// copy's board.ts with a tombstone snapshot, and E leaving the page live; without a webhook, the error and E kept.
// Never touches the real app/src/data/board.ts or app/.env.local. Prints one PASS/FAIL line per step.
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = join(ROOT, "app");
const RUNS_DIR = join(ROOT, "runs");
const CHROME =
  process.env.CHROME_PATH ||
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const AUTH = "Bearer e2e-test-value with  spaces==";
const STORAGE_KEY = "action-board:app-answers";

const { createServer: createVite } = await import(pathToFileURL(join(APP_DIR, "node_modules/vite/dist/node/index.js")).href);

// The only supported write path for board.ts.
const AB = join(ROOT, "bin/ab.mjs");
// The app copy lives in a temp dir with no ../bin, so point its POST /__ab/priority route at the repo's ab.
process.env.AB_BIN = AB;

// Keep the shell's env out of Vite's loadEnv; only the temp .env.local counts.
delete process.env.ACTION_BOARD_WEBHOOK_URL;
delete process.env.ACTION_BOARD_WEBHOOK_AUTH;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const results = [];
async function step(label, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    results.push({ label, ok: true });
    console.log(`PASS ${label}${note ? ` -- ${note}` : ""} (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ label, ok: false });
    console.log(`FAIL ${label} -- ${err?.message ?? err}`);
  }
}

// ---------- mock receivers ----------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

async function startReceiver(withCors) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const ua = String(req.headers["user-agent"] ?? "");
      requests.push({
        method: req.method,
        from: /Chrome/.test(ua) ? "browser" : "node",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const cors = withCors ? CORS_HEADERS : {};
      if (req.method === "OPTIONS") {
        // A typical webhook endpoint has no CORS support and rejects the preflight.
        res.writeHead(withCors ? 204 : 405, cors).end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json", ...cors }).end('{"ok":true}');
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, requests, close: () => new Promise((r) => server.close(r)) };
}

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

// ---------- app copy + Vite ----------

// Top-level app/ entries never copied: every .env* file (only the temp .env.local written below counts),
// build output, and the real app's logs.
const SKIP = new Set(["node_modules", "dist", ".delivery-log.jsonl", ".ab-log.jsonl", ".ab-cleared.jsonl"]);
const skipTop = (name) => name.startsWith(".env") || SKIP.has(name);

function makeAppCopy(envLines) {
  // realpath: on macOS tmpdir() is under /var, a symlink to /private/var, and Vite's fs.allow compares real paths.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ab-e2e-")));
  const copy = join(tmp, "app");
  cpSync(APP_DIR, copy, { recursive: true, filter: (src) => !skipTop(src.slice(APP_DIR.length + 1).split("/")[0]) });
  symlinkSync(join(APP_DIR, "node_modules"), join(copy, "node_modules"), "dir");
  writeFileSync(join(copy, ".env.local"), envLines.join("\n") + "\n");
  const boardFile = join(copy, "src/data/board.ts");
  isolateBoard(boardFile);
  return { tmp, copy, boardFile };
}

// Rewrites the COPY's board.ts so the run does not depend on the real board's open decisions:
// decisions become [], updated_at and glance stay. If the glance has no linked item, adds a linked
// fixture waiting item and a fixture others item so the glance link check has something to look at.
// Text outside the JSON markers is left as is.
const JSON_START = "/* BOARD-JSON-START */";
const JSON_END = "/* BOARD-JSON-END */";
function isolateBoard(boardFile) {
  const src = readFileSync(boardFile, "utf8");
  const a = src.indexOf(JSON_START);
  const b = src.indexOf(JSON_END);
  assert(a !== -1 && b > a, `board markers not found in ${boardFile}`);
  const board = JSON.parse(src.slice(a + JSON_START.length, b));
  board.decisions = [];
  const glance = board.glance;
  const items = [...(glance.waiting ?? []), ...(glance.tickets ?? []), ...(glance.others ?? [])];
  if (!items.some((it) => it.link)) {
    const link = "https://github.com/acme/example/pull/1800";
    glance.waiting = [...(glance.waiting ?? []), { title: "[e2e] fixture waiting item", who: "E2E", link }];
    glance.others = [...(glance.others ?? []), { title: "[e2e] fixture others PR", author: "E2E", who: "Your review requested", link }];
  }
  const json = JSON.stringify(board, null, 2);
  writeFileSync(boardFile, `${src.slice(0, a + JSON_START.length)}\n${json}\n${src.slice(b)}`);
}

// The copy's board JSON, between the same markers.
function readBoard(boardFile) {
  const src = readFileSync(boardFile, "utf8");
  return JSON.parse(src.slice(src.indexOf(JSON_START) + JSON_START.length, src.indexOf(JSON_END)));
}

async function startVite(app) {
  const port = await freePort();
  const server = await createVite({
    configFile: join(app.copy, "vite.config.ts"),
    root: app.copy,
    cacheDir: join(app.tmp, ".vite-cache"),
    logLevel: "error",
    server: { port, strictPort: true, open: false, fs: { allow: [app.tmp, join(APP_DIR, "node_modules")] } },
  });
  await server.listen();
  return { server, url: `http://localhost:${port}/`, abUrl: `http://localhost:${port}` };
}

// Runs bin/ab.mjs on the copy's board.ts. With abUrl it also waits for that Vite server to serve the change
// (raise exits 3 if it does not); without one (before Vite starts) it runs with AB_NO_SERVER=1.
// Async on purpose: Vite runs in this process, so a blocking call would stall the server ab is polling.
const runAb = (boardFile, abUrl, args) => {
  const env = { ...process.env, AB_FILE: boardFile };
  delete env.AB_URL;
  delete env.AB_NO_SERVER;
  if (abUrl) env.AB_URL = abUrl;
  else env.AB_NO_SERVER = "1";
  return promisify(execFile)(process.execPath, [AB, ...args], { env });
};
// ab raise needs a card title and blocking; the title is stored on the board and shown bold at the top of the card.
const addDecision = (boardFile, d, abUrl) => runAb(boardFile, abUrl, ["raise", JSON.stringify(d)]);
const markAnswer = (boardFile, id, opt, abUrl) => runAb(boardFile, abUrl, ["answer", id, opt, "--by", "chat"]);

const decision = (id, title, question) => ({
  id,
  title,
  card_ref: "PROJ-E2E",
  context: "A throwaway card for the local end-to-end check. Answering it posts to a mock webhook, nothing real.",
  question,
  what_happens_after: "Nothing real happens; this is the local e2e.",
  options: [
    { id: "yes", label: "Yes, ship it" },
    { id: "no", label: "Not yet" },
  ],
  blocking: false,
});

// ---------- page helpers ----------

const cardIds = (page) => page.$$eval("article.card", (els) => els.map((e) => e.getAttribute("data-decision-id")));
// The Needs you sections top to bottom: level, heading text ("High 1"), card ids, and the section's top edge.
const sectionsOn = (page) =>
  page.$$eval(".queue > section.priority-section", (ss) =>
    ss.map((s) => ({
      level: s.dataset.level,
      heading: s.querySelector("h3.priority-heading").textContent.replace(/\s+/g, " ").trim(),
      ids: [...s.querySelectorAll("article.card")].map((e) => e.getAttribute("data-decision-id")),
      top: s.getBoundingClientRect().top,
    })),
  );
// Asserts the sections are exactly `want` ([[level, ids]...]) in that order, top to bottom, with matching headings.
async function checkSections(page, want, what) {
  const got = await sectionsOn(page);
  const shape = (xs) => JSON.stringify(xs.map((s) => [s.level, s.ids]));
  assert(shape(got) === JSON.stringify(want), `${what}: sections ${shape(got)}, want ${JSON.stringify(want)}`);
  const label = { high: "High", medium: "Medium", low: "Low" };
  for (const [i, s] of got.entries()) {
    assert(s.heading === `${label[s.level]} ${s.ids.length}`, `${what}: ${s.level} heading "${s.heading}"`);
    if (i > 0) assert(s.top > got[i - 1].top, `${what}: ${s.level} section not below ${got[i - 1].level}`);
  }
  return got.map((s) => s.heading).join(", ");
}
// Every visible card whose fixture has a title shows it as its first child, a .card-title in bold (weight >= 600).
async function checkTitles(page, fixtures, what) {
  const cards = await page.$$eval("article.card", (els) =>
    els.map((e) => {
      const first = e.firstElementChild;
      return {
        id: e.getAttribute("data-decision-id"),
        firstClass: first?.className ?? null,
        text: first?.textContent ?? null,
        weight: first ? Number(getComputedStyle(first).fontWeight) : 0,
      };
    }),
  );
  let n = 0;
  for (const c of cards) {
    const f = fixtures.find((x) => x.id === c.id);
    if (!f?.title) continue;
    assert(c.firstClass === "card-title", `${what}: ${c.id} first child is .${c.firstClass}, want .card-title`);
    assert(c.text === f.title, `${what}: ${c.id} title "${c.text}", want "${f.title}"`);
    assert(c.weight >= 600, `${what}: ${c.id} title font-weight ${c.weight}, want >= 600`);
    n++;
  }
  assert(n > 0, `${what}: no titled card visible`);
  return `${n} bold titles`;
}
const readAnswers = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "{}"), STORAGE_KEY);
const markerText = (page) => page.$eval(".marker", (e) => e.textContent).catch(() => null);

// "Explain this better" sits in .card-meta at the card's top right. At 1280 it is right of the question; at 360 the
// meta column wraps below the question. Either way the question, the meta column and the button never intersect and
// the button stays inside the card. The priority control (in .card-meta, between the stamp and the button) touches
// neither the question nor the button and stays inside the card; at 1280 it sits in the top right, right of the
// question and near its top. "Not relevant anymore" is in the card footer, below the answer controls, and touches
// neither the question, .card-meta, the answer controls nor the evidence link, and stays inside the card.
// Restores the 1280x900 viewport (a resize does not reload the page).
async function checkClarifyLayout(page) {
  const measure = () =>
    page.$$eval("article.card", (cards) =>
      cards
        .filter((c) => c.getClientRects().length > 0)
        .map((c) => {
          const box = (e) => {
            const r = e?.getBoundingClientRect();
            return r && { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          };
          const btn = [...c.querySelectorAll(".card-meta button")].find((b) => b.textContent === "Explain this better");
          const nr = [...c.querySelectorAll("button")].filter((b) => b.textContent === "Not relevant anymore");
          return {
            id: c.dataset.decisionId,
            card: box(c),
            q: box(c.querySelector(".question")),
            meta: box(c.querySelector(".card-meta")),
            btn: box(btn),
            prio: box(c.querySelector('.priority[role="group"]')),
            nrCount: nr.length,
            nrInFoot: nr.length === 1 && nr[0].closest(".card-foot")?.parentElement === c,
            nr: box(nr[0]),
            options: [...c.querySelectorAll(".options button, .submit-row button, .custom input, .custom button")].map(box),
            evidence: box(c.querySelector(".evidence")),
          };
        }),
    );
  const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const counts = [];
  try {
    for (const [width, height] of [
      [1280, 900],
      [360, 800],
    ]) {
      await page.setViewport({ width, height });
      await sleep(150);
      const cards = await measure();
      assert(cards.length > 0, `no visible cards at ${width}`);
      for (const { id, card, q, meta, btn, prio, nrCount, nrInFoot, nr, options, evidence } of cards) {
        const at = `card ${id} at ${width}px`;
        // "Not relevant anymore": one per card, in the footer row, clear of everything else, inside the card.
        assert(nrCount === 1 && nrInFoot && nr, `${at}: ${nrCount} "Not relevant anymore" controls, in the card footer: ${nrInFoot}`);
        assert(!hits(nr, q), `${at}: Not relevant anymore overlaps the question`);
        assert(!hits(nr, meta), `${at}: Not relevant anymore overlaps .card-meta`);
        assert(!options.some((o) => hits(nr, o)), `${at}: Not relevant anymore overlaps an answer control`);
        assert(!evidence || !hits(nr, evidence), `${at}: Not relevant anymore overlaps the evidence link`);
        assert(
          nr.left >= card.left && nr.right <= card.right && nr.top >= card.top && nr.bottom <= card.bottom,
          `${at}: Not relevant anymore overflows the card (${nr.left}-${nr.right} vs ${card.left}-${card.right})`,
        );
        assert(options.every((o) => nr.top >= o.bottom), `${at}: Not relevant anymore is not below the answer controls`);
        assert(q && meta && btn, `${at}: question, .card-meta or the button is missing`);
        assert(!hits(q, btn), `${at}: button overlaps the question`);
        assert(!hits(q, meta), `${at}: .card-meta overlaps the question`);
        assert(prio, `${at}: priority control is missing`);
        assert(!hits(prio, q), `${at}: priority control overlaps the question`);
        assert(!hits(prio, btn), `${at}: priority control overlaps Explain this better`);
        assert(
          prio.left >= meta.left && prio.right <= meta.right && prio.top >= meta.top && prio.bottom <= meta.bottom,
          `${at}: priority control is not inside .card-meta`,
        );
        assert(
          prio.left >= card.left && prio.right <= card.right && prio.top >= card.top && prio.bottom <= card.bottom,
          `${at}: priority control overflows the card (${prio.left}-${prio.right} vs ${card.left}-${card.right})`,
        );
        if (width === 1280) {
          assert(prio.left >= q.right, `${at}: priority left ${prio.left} not right of question right ${q.right}`);
          assert(prio.top < q.top + 60, `${at}: priority top ${prio.top} not in the top right (question top ${q.top})`);
        }
        if (width === 1280) assert(btn.left >= q.right, `${at}: button left ${btn.left} not right of question right ${q.right}`);
        else {
          assert(btn.top >= q.bottom || !hits(q, btn), `${at}: button not below the question`);
          assert(btn.right <= card.right && btn.left >= card.left, `${at}: button overflows the card (${btn.left}-${btn.right} vs ${card.left}-${card.right})`);
        }
      }
      counts.push(`${cards.length} at ${width}`);
    }
  } finally {
    await page.setViewport({ width: 1280, height: 900 });
  }
  return `card layout ok (${counts.join(", ")})`;
}

async function waitFor(fn, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// ---------- scenarios ----------

const SCENARIOS = [
  { key: "no-cors", title: "receiver without CORS headers", cors: false, expectDirect: false },
  { key: "cors", title: "receiver with CORS headers", cors: true, expectDirect: true },
  { key: "unset", title: "no webhook URL in .env.local", cors: null },
];

const args = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args });
mkdirSync(RUNS_DIR, { recursive: true });
const summary = [];

try {
  for (const sc of SCENARIOS) {
    const receiver = sc.cors === null ? null : await startReceiver(sc.cors);
    const app = makeAppCopy(
      receiver
        ? [`ACTION_BOARD_WEBHOOK_URL=${receiver.url}`, `ACTION_BOARD_WEBHOOK_AUTH=${AUTH}`]
        : ["ACTION_BOARD_WEBHOOK_URL=", "ACTION_BOARD_WEBHOOK_AUTH="],
    );
    const A = decision(`e2e-${sc.key}-a`, `Local check card A (${sc.key})`, `[e2e ${sc.key}] A: answer me in the app`);
    const B = decision(`e2e-${sc.key}-b`, `Local check card B (${sc.key})`, `[e2e ${sc.key}] B: the assistant marks this answered in chat`);
    const C = decision(`e2e-${sc.key}-c`, `Local check card C (${sc.key})`, `[e2e ${sc.key}] C: added while the page is open`);
    const D = decision(`e2e-${sc.key}-d`, `Local check card D (${sc.key})`, `[e2e ${sc.key}] D: an older card for the priority order`);
    const E = decision(`e2e-${sc.key}-e`, `Local check card E (${sc.key})`, `[e2e ${sc.key}] E: a card that is not relevant anymore`);
    const fixtures = [A, B, C, D, E];
    let vite;
    let page;
    const row = { scenario: sc.title };
    console.log(`\n== ${sc.title} ==`);

    try {
      await step(`[${sc.key}] 1. copy app, add decisions A and B with ab raise, start Vite, load page`, async () => {
        await addDecision(app.boardFile, A);
        await addDecision(app.boardFile, B);
        vite = await startVite(app);
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto(vite.url, { waitUntil: "domcontentloaded" });
        await waitFor(async () => (await cardIds(page)).includes(B.id), 20000, "cards A and B");
        const ids = await cardIds(page);
        assert(ids.includes(A.id) && ids.includes(B.id), `cards shown: ${ids}`);
        const h2 = await page.$eval(".needs-you h2", (e) => e.textContent);
        assert(/^Needs you\s*2$/.test(h2), `heading was ${h2}`);
        const links = await page.$$eval(".glance a.item", (as) => as.map((a) => a.target));
        assert(links.length > 0 && links.every((t) => t === "_blank"), "glance links should open in a new tab");
        const panels = await page.$$eval(".glance h3", (hs) => hs.map((h) => h.textContent.trim()));
        assert(panels.some((t) => t.startsWith("Others' PRs with you")), `glance panels: ${panels.join(" | ")}`);
        const layout = await checkClarifyLayout(page);
        const titles = await checkTitles(page, fixtures, "step 1");
        await page.evaluate(() => (window.__e2eNoReload = true));
        return `${ids.length} cards, ${links.length} glance links, ${layout}, ${titles}`;
      });

      await step(`[${sc.key}] 2. click "Yes, ship it" on A: card hides, toast, delivery`, async () => {
        const btn = await page.$(`article.card[data-decision-id="${A.id}"] .options button`);
        assert(btn, "A's first option button not found");
        await btn.click();
        await waitFor(async () => !(await cardIds(page)).includes(A.id), 1000, "card A to hide");
        row.hidden = true;
        const toast = await waitFor(() => page.$eval(".toast", (e) => e.textContent).catch(() => null), 2000, "toast");
        assert(toast === "Answered: Yes, ship it", `toast was ${toast}`);

        if (!receiver) {
          await sleep(1500);
          const rec = (await readAnswers(page))[A.id];
          row.status = rec?.status;
          row.marker = await markerText(page);
          assert(rec?.status === "pending" && rec.attempts === 0, `expected pending/0 attempts, got ${rec?.status}/${rec?.attempts}`);
          assert(row.marker === "Webhook not set up (app/.env.local)", `marker was ${row.marker}`);
          return `status pending, marker "${row.marker}"`;
        }

        const rec = await waitFor(async () => {
          const r = (await readAnswers(page))[A.id];
          return r && r.status !== "pending" ? r : null;
        }, 15000, "delivery to finish");
        await sleep(300);
        const posts = receiver.requests.filter((r) => r.method === "POST");
        const direct = posts.filter((r) => r.from === "browser");
        const fallback = posts.filter((r) => r.from === "node");
        const preflights = receiver.requests.filter((r) => r.method === "OPTIONS").length;
        Object.assign(row, {
          preflights,
          directPostReached: direct.length > 0,
          fallbackDelivered: fallback.length > 0,
          status: rec.status,
          attempts: rec.attempts,
          last_http: rec.last_http,
          headerVerbatim: posts.length > 0 && posts.every((r) => r.authorization === AUTH && r.contentType === "application/json"),
          marker: await markerText(page),
        });
        const expected = {
          event: "decision.answered",
          decision_id: A.id,
          card_ref: "PROJ-E2E",
          question: A.question,
          answer: "yes",
          answer_label: "Yes, ship it",
          answered_by: "app",
          answered_at: rec.payload.answered_at,
        };
        const exact = posts.every((r) => r.body === JSON.stringify(expected));
        assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(rec.payload.answered_at), "answered_at is not ISO UTC");
        assert(rec.status === "delivered" && rec.last_http === 200, `status ${rec.status}, last_http ${rec.last_http}`);
        assert(posts.length === 1, `expected exactly 1 POST at the receiver, got ${posts.length}`);
        assert(row.directPostReached === sc.expectDirect, `direct POST reached: ${row.directPostReached}`);
        assert(row.fallbackDelivered === !sc.expectDirect, `fallback delivered: ${row.fallbackDelivered}`);
        assert(row.headerVerbatim, "Authorization header not verbatim");
        assert(exact, "payload not exact");
        assert(row.marker === null, `marker shown: ${row.marker}`);
        return `direct POST reached=${row.directPostReached}, fallback delivered=${row.fallbackDelivered}, preflights=${preflights}, status=${rec.status} (HTTP ${rec.last_http}, ${rec.attempts} attempt), header verbatim, payload exact`;
      });

      await step(`[${sc.key}] 3. ab answer on B: leaves Needs you live (/__ab/events), no reload`, async () => {
        await markAnswer(app.boardFile, B.id, "no", vite.abUrl);
        await waitFor(async () => !(await cardIds(page)).includes(B.id), 10000, "card B to leave Needs you");
        assert(await page.evaluate(() => window.__e2eNoReload === true), "page reloaded");
        const h2 = await page.$eval(".needs-you h2", (e) => e.textContent);
        assert(/^Needs you\s*0$/.test(h2), `heading was ${h2}`);
        return "B gone, same page instance";
      });

      await step(`[${sc.key}] 4. ab raise for C while open: appears live, no reload`, async () => {
        await addDecision(app.boardFile, C, vite.abUrl);
        await waitFor(async () => (await cardIds(page)).includes(C.id), 10000, "card C to appear");
        assert(await page.evaluate(() => window.__e2eNoReload === true), "page reloaded");
        await checkTitles(page, fixtures, "step 4");
        if (sc.key === "no-cors") {
          await sleep(5500); // let the toast fade so the screenshot shows just the board
          await page.screenshot({ path: join(RUNS_DIR, "e2e-local.png") });
          return "C shown; screenshot runs/e2e-local.png";
        }
        return "C shown";
      });

      if (receiver) {
        await step(`[${sc.key}] 5. reload: A stays hidden, file-answered B stays hidden, no re-delivery`, async () => {
          const before = receiver.requests.filter((r) => r.method === "POST").length;
          await page.reload({ waitUntil: "domcontentloaded" });
          await waitFor(async () => (await cardIds(page)).includes(C.id), 10000, "board after reload");
          await sleep(1000);
          const ids = await cardIds(page);
          assert(!ids.includes(A.id) && !ids.includes(B.id), `cards shown: ${ids}`);
          const after = receiver.requests.filter((r) => r.method === "POST").length;
          assert(after === before, `receiver got ${after - before} more POSTs`);
          return `cards shown: ${ids.join(", ")}`;
        });
      }

      await step(`[${sc.key}] 6. "Explain this better" on C: decision.clarify POST, Rewording..., re-raise clears it`, async () => {
        const sel = `article.card[data-decision-id="${C.id}"]`;
        const text = (cls) => page.$eval(`${sel} .${cls}`, (e) => e.textContent).catch(() => null);
        const clarifyDisabled = () =>
          page.evaluate((s) => [...document.querySelectorAll(`${s} button`)].find((b) => b.textContent === "Explain this better")?.disabled ?? null, sel);
        await page.evaluate(() => (window.__e2eNoReload = true));
        const before = receiver ? receiver.requests.length : 0;
        await page.evaluate((s) => [...document.querySelectorAll(`${s} button`)].find((b) => b.textContent === "Explain this better").click(), sel);

        if (!receiver) {
          // No webhook URL: it goes to the /__ab/webhook fallback, which has no URL either. It answers 503 with
          // body {"status":null}; the card's HTTP code is the receiver status from that body, and there is no
          // receiver, so the error carries no code.
          const err = await waitFor(() => text("clarify-error"), 10000, "the clarify error");
          assert(err === "Could not send. Try again.", `error was ${err}`);
          assert((await clarifyDisabled()) === false, "button not re-enabled after the failure");
          assert((await cardIds(page)).includes(C.id), "card C hidden");
          return `error "${err}", button enabled`;
        }

        const status = await waitFor(() => text("clarify-status"), 10000, "Rewording...");
        assert(status === "Rewording...", `status was ${status}`);
        assert((await clarifyDisabled()) === true, "button not disabled while rewording");
        await sleep(300);
        const posts = receiver.requests.slice(before).filter((r) => r.method === "POST");
        assert(posts.length === 1, `expected exactly 1 clarify POST, got ${posts.length}`);
        const body = JSON.parse(posts[0].body);
        assert(
          Object.keys(body).join() === "event,decision_id,question,context,clicked_at" &&
            body.event === "decision.clarify" &&
            body.decision_id === C.id &&
            body.question === C.question &&
            body.context === C.context &&
            /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(body.clicked_at),
          `payload was ${posts[0].body}`,
        );
        assert(posts[0].authorization === AUTH && posts[0].contentType === "application/json", "Authorization header not verbatim");
        assert((posts[0].from === "browser") === sc.expectDirect, `clarify came from ${posts[0].from}`);
        assert(!(C.id in (await readAnswers(page))), "clarify stored an answer");

        const reworded = `[e2e ${sc.key}] C: reworded after Explain this better`;
        await addDecision(app.boardFile, { ...C, question: reworded }, vite.abUrl);
        await waitFor(async () => (await text("question")) === reworded, 10000, "the new question on C");
        await waitFor(async () => (await text("clarify-status")) === null, 5000, "Rewording... to clear");
        assert((await clarifyDisabled()) === false, "button not re-enabled after the re-raise");
        assert(await page.evaluate(() => window.__e2eNoReload === true), "page reloaded");
        return `1 decision.clarify POST (${posts[0].from}), Rewording... cleared by ab raise`;
      });

      await step(`[${sc.key}] 7. tap High on C: pressed, moves to the High section, saved to the copy's board.ts; Low survives a reload`, async () => {
        const sel = `article.card[data-decision-id="${C.id}"]`;
        const tapLevel = (id, label) =>
          page.evaluate(
            (s, l) => [...document.querySelectorAll(`${s} .priority button`)].find((b) => b.textContent === l).click(),
            `article.card[data-decision-id="${id}"]`,
            label,
          );
        const pressedOn = (id) =>
          page.$$eval(`article.card[data-decision-id="${id}"] .priority button[aria-pressed="true"]`, (bs) => bs.map((b) => b.textContent).join());
        const levelInFile = (id) => readBoard(app.boardFile).decisions.find((x) => x.id === id)?.priority;
        // D is older than C and both are medium, so D leads until C goes high.
        await addDecision(app.boardFile, { ...D, created_at: "2026-01-01T09:00:00.000Z" }, vite.abUrl);
        await waitFor(async () => (await cardIds(page)).join() === `${D.id},${C.id}`, 10000, `order ${D.id},${C.id}`);
        assert((await pressedOn(C.id)) === "Medium", `C pressed ${await pressedOn(C.id)}`);
        // Only non-empty levels get a section: both medium, so one Medium section.
        await checkSections(page, [["medium", [D.id, C.id]]], "before the taps");
        const before = readBoard(app.boardFile).decisions;
        assert(!("priority" in before.find((x) => x.id === C.id)), "C already has a priority in the file");

        await page.evaluate(() => (window.__e2eNoReload = true));
        await tapLevel(C.id, "High");
        await waitFor(async () => (await pressedOn(C.id)) === "High", 2000, "C's High pressed");
        await waitFor(async () => (await cardIds(page))[0] === C.id, 2000, "C at the top");
        assert((await page.$eval(sel, (e) => e.dataset.priority)) === "high", "data-priority not high");
        // C in the High section, above the Medium section holding D.
        const highSections = await checkSections(page, [["high", [C.id]], ["medium", [D.id]]], "after High");
        await waitFor(() => levelInFile(C.id) === "high", 10000, "priority high in the copy's board.ts");
        const after = readBoard(app.boardFile).decisions;
        assert(after.length === before.length, `decision count ${before.length} -> ${after.length}`);
        for (const [i, x] of after.entries()) {
          const want = x.id === C.id ? { ...before[i], priority: "high" } : before[i];
          assert(JSON.stringify(x) === JSON.stringify(want), `decision ${x.id} changed beyond C's priority`);
        }
        assert((await page.$(`${sel} .priority-error`)) === null, "priority error shown");
        const layout = await checkClarifyLayout(page);

        await tapLevel(C.id, "Low");
        await waitFor(async () => (await pressedOn(C.id)) === "Low", 2000, "C's Low pressed");
        // C in the Low section, below the Medium section holding D; no High section left.
        const lowSections = await checkSections(page, [["medium", [D.id]], ["low", [C.id]]], "after Low");
        await waitFor(() => levelInFile(C.id) === "low", 10000, "priority low in the copy's board.ts");
        assert(await page.evaluate(() => window.__e2eNoReload === true), "page reloaded before the reload step");
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitFor(async () => (await cardIds(page)).includes(C.id), 10000, "board after reload");
        let seen;
        await waitFor(async () => (seen = await pressedOn(C.id)) === "Low", 5000, "C's Low pressed after reload").catch((e) => {
          throw new Error(`${e.message} (last saw C pressed "${seen}")`);
        });
        await waitFor(async () => (seen = (await cardIds(page)).join()) === `${D.id},${C.id}`, 5000, `order ${D.id},${C.id} after reload`).catch((e) => {
          throw new Error(`${e.message} (last saw order ${seen})`);
        });
        await checkSections(page, [["medium", [D.id]], ["low", [C.id]]], "after reload");
        return `High moved C to the top and wrote "high" (${highSections}); Low kept after reload (${lowSections}); ${layout}`;
      });

      await step(`[${sc.key}] 8. "Not relevant anymore" on E: ${receiver ? "decision.not_relevant POST, then cleared from the copy's board.ts, gone live" : "Could not send, card kept"}`, async () => {
        const sel = `article.card[data-decision-id="${E.id}"]`;
        const text = (cls) => page.$eval(`${sel} .${cls}`, (e) => e.textContent).catch(() => null);
        const nrDisabled = () =>
          page.evaluate((s) => [...document.querySelectorAll(`${s} button`)].find((b) => b.textContent === "Not relevant anymore")?.disabled ?? null, sel);
        const needsYou = async () => Number((await page.$eval(".needs-you h2 .n", (e) => e.textContent)).trim());
        // The copy's tombstones sit two folders above its board.ts, like the real board's.
        const tombFile = join(dirname(app.boardFile), "..", "..", ".ab-cleared.jsonl");
        const tombs = () => {
          try {
            return readFileSync(tombFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
          } catch {
            return [];
          }
        };
        await addDecision(app.boardFile, E, vite.abUrl);
        await waitFor(async () => (await cardIds(page)).includes(E.id), 10000, "card E to appear");
        const layout = await checkClarifyLayout(page);
        const count = await needsYou();
        const stored = readBoard(app.boardFile).decisions.find((x) => x.id === E.id);
        await page.evaluate(() => (window.__e2eNoReload = true));
        const before = receiver ? receiver.requests.length : 0;
        await page.evaluate((s) => [...document.querySelectorAll(`${s} button`)].find((b) => b.textContent === "Not relevant anymore").click(), sel);

        if (!receiver) {
          // No webhook URL: the /__ab/webhook fallback answers 503 three times, so nothing is cleared.
          const err = await waitFor(() => text("not-relevant-error"), 10000, "the not relevant error");
          assert(err === "Could not send. Try again.", `error was ${err}`);
          assert((await nrDisabled()) === false, "control not re-enabled after the failure");
          assert((await cardIds(page)).includes(E.id), "card E hidden");
          assert(readBoard(app.boardFile).decisions.some((x) => x.id === E.id), "E was cleared from the copy's board.ts");
          assert(tombs().length === 0, "a tombstone was written");
          assert((await needsYou()) === count, "Needs you count changed");
          return `error "${err}", card kept in board.ts, control enabled; ${layout}`;
        }

        await waitFor(async () => !(await cardIds(page)).includes(E.id), 15000, "card E to leave the page");
        assert(await page.evaluate(() => window.__e2eNoReload === true), "page reloaded");
        assert((await needsYou()) === count - 1, `Needs you ${count} -> ${await needsYou()}`);
        assert(!readBoard(app.boardFile).decisions.some((x) => x.id === E.id), "E still in the copy's board.ts");
        const t = tombs().filter((x) => x.id === E.id);
        assert(t.length === 1 && t[0].reason === "not relevant", `tombstones for E: ${JSON.stringify(t)}`);
        assert(JSON.stringify(t[0].card) === JSON.stringify(stored), "tombstone card snapshot differs from the stored card");
        await sleep(300);
        const posts = receiver.requests.slice(before).filter((r) => r.method === "POST");
        assert(posts.length === 1, `expected exactly 1 decision.not_relevant POST, got ${posts.length}`);
        const body = JSON.parse(posts[0].body);
        assert(
          Object.keys(body).join() === "event,decision_id,question,cleared_at" &&
            body.event === "decision.not_relevant" &&
            body.decision_id === E.id &&
            body.question === E.question &&
            /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(body.cleared_at),
          `payload was ${posts[0].body}`,
        );
        assert(posts[0].authorization === AUTH && posts[0].contentType === "application/json", "Authorization header not verbatim");
        assert((posts[0].from === "browser") === sc.expectDirect, `not relevant came from ${posts[0].from}`);
        assert(!(E.id in (await readAnswers(page))), "not relevant stored an answer");
        return `1 decision.not_relevant POST (${posts[0].from}), E cleared with reason "not relevant" and a card snapshot, Needs you ${count} -> ${count - 1}; ${layout}`;
      });
    } finally {
      summary.push(row);
      await page?.close().catch(() => {});
      await vite?.server.close().catch(() => {});
      await receiver?.close();
      rmSync(app.tmp, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
}

console.log("\n== CORS results ==");
for (const r of summary) console.log(JSON.stringify(r));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
