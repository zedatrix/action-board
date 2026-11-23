// README screenshots from the RUNNING dev server (default http://127.0.0.1:8085, AB_URL to change).
// Read-only: loads the page and saves PNGs to docs/screenshots/. Run it on the example data, never a real board.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/screenshots");
const URL_ = process.env.AB_URL || "http://127.0.0.1:8085";
const CHROME =
  process.env.CHROME_PATH ||
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");

const shots = [
  { file: "board-desktop.png", hash: "", width: 1440, height: 900, fullPage: true },
  { file: "project-tab-desktop.png", hash: "#project", width: 1100, height: 380, fullPage: false, scale: 2 },
  { file: "board-phone.png", hash: "", width: 390, height: 844, fullPage: false, scale: 2 },
];

mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
try {
  for (const s of shots) {
    const page = await browser.newPage();
    await page.setViewport({ width: s.width, height: s.height, deviceScaleFactor: s.scale ?? 1 });
    // The page holds a live event stream open, so wait for the DOM, not for the network to go quiet.
    await page.goto(`${URL_}/${s.hash}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".shell, .page", { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: join(OUT, s.file), fullPage: s.fullPage });
    console.log(`saved docs/screenshots/${s.file}`);
    await page.close();
  }
} finally {
  await browser.close();
}
