// Start a fresh sample-only server and capture the README screenshots.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { createServer } from "../app/node_modules/vite/dist/node/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/screenshots");
const CHROME =
  process.env.CHROME_PATH ||
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");

const shots = [
  { file: "board-desktop.png", hash: "", width: 1440, height: 900, fullPage: true, ready: "#todos-heading" },
  { file: "todos-desktop.png", hash: "", width: 1440, height: 900, element: ".todos", ready: ".todos .todo-list" },
  { file: "prs-tab-desktop.png", hash: "#prs", width: 1440, height: 900, fullPage: true, ready: "#panel-prs .pr-chips" },
  { file: "project-tab-desktop.png", hash: "#project", width: 1100, height: 380, scale: 2, ready: "#panel-project .project-table" },
  { file: "board-phone.png", hash: "", width: 390, height: 844, scale: 2, ready: "#todos-heading" },
];

mkdirSync(OUT, { recursive: true });
const server = await createServer({ root: join(ROOT, "app"), mode: "sample", server: { port: 5173, strictPort: false, open: false, hmr: false } });
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Sample server has no loopback port");
  const base = `http://127.0.0.1:${address.port}/`;
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, pipe: true });
  for (const shot of shots) {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: shot.width, height: shot.height, deviceScaleFactor: shot.scale ?? 1 });
      // Live updates hold a connection open. Wait for the feature and the local fonts.
      await page.goto(base + shot.hash, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(shot.ready, { visible: true, timeout: 10000 });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const path = join(OUT, shot.file);
      if (shot.element) await (await page.waitForSelector(shot.element)).screenshot({ path });
      else await page.screenshot({ path, fullPage: shot.fullPage ?? false });
      console.log(`saved docs/screenshots/${shot.file}`);
    } finally {
      await page.close();
    }
  }
} finally {
  try {
    await browser?.close();
  } finally {
    await server.close();
  }
}
