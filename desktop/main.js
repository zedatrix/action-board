// Electron main process: wraps the Action Board (Vite dev server on :8085) in a desktop window,
// with a dock badge for open cards, notifications for new ones, a global shortcut, and launch at login.
const { app, BrowserWindow, Menu, nativeImage, Notification, globalShortcut, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTracker, notificationFor, tabMenuItems } = require("./logic");

const BOARD_DIR = process.env.ACTION_BOARD_HOME || (app.isPackaged
  ? path.join(os.homedir(), "action-board")
  : path.resolve(__dirname, ".."));
function boardPort() {
  if (process.env.ACTION_BOARD_PORT) return Number(process.env.ACTION_BOARD_PORT) || 8085;
  try {
    const settings = fs.readFileSync(path.join(BOARD_DIR, "app", ".env.local"), "utf8");
    const port = [...settings.matchAll(/^ACTION_BOARD_PORT\s*=\s*["']?(\d+)/gm)].at(-1);
    return Number(port?.[1]) || 8085;
  } catch {
    return 8085;
  }
}
const BASE = (process.env.ACTION_BOARD_URL || `http://127.0.0.1:${boardPort()}`).replace(/\/+$/, "");
const BOARD_URL = BASE + "/__ab/board";
const LAUNCHD_LABEL = "com.example.action-board";
const ICON = nativeImage.createFromPath(path.join(__dirname, "icon", "icon.png"));
const SHORTCUT = "CommandOrControl+Shift+A";
const POLL_MS = 3000;
const RETRY_URL = "action-board://retry";

// Keep everything inside ~/action-board/desktop. Packaged, __dirname is inside the .app, so use the repo copy.
const USER_DATA = app.isPackaged ? path.join(BOARD_DIR, "desktop", ".userdata") : path.join(__dirname, ".userdata");
app.setPath("userData", USER_DATA);
app.setName("Action Board");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(start);
}

let win = null;
let quitting = false;
let serverUp = false;
let starting = false;
let shortcutRegistered = false;
let lastBadge = null;
let lastFreshIds = [];
let notificationsShown = 0;
let lastNotificationEvent = null;
let lastNotificationError = null;
const tracker = createTracker();
const liveNotifications = new Set(); // hold references so click handlers survive GC

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe() {
  try {
    const res = await fetch(BOARD_URL, { signal: AbortSignal.timeout(2000), cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUp(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await probe()) return true;
    await sleep(1000);
  }
  return false;
}

function kickstartLaunchd() {
  return new Promise((resolve) => {
    execFile("/bin/launchctl", ["kickstart", `gui/${process.getuid()}/${LAUNCHD_LABEL}`], (err) => {
      console.log(err ? `launchctl kickstart failed: ${err.message}` : "launchctl kickstart sent");
      resolve();
    });
  });
}

function spawnVite() {
  const appDir = path.join(BOARD_DIR, "app");
  const vite = path.join(appDir, "node_modules", ".bin", "vite");
  if (!fs.existsSync(vite)) {
    console.log(`vite not found at ${vite}`);
    return;
  }
  // GUI apps get a bare PATH; vite's shebang needs node.
  const PATH = ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH || "/usr/bin:/bin"].join(":");
  const child = spawn(vite, ["--strictPort"], {
    cwd: appDir,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PATH },
  });
  child.on("error", (e) => console.log(`vite spawn failed: ${e.message}`));
  child.unref();
  console.log(`spawned vite (pid ${child.pid})`);
}

// Reuse a running board; otherwise start it the way it runs today (launchd job, then vite directly).
async function ensureServer() {
  if (await probe()) return true;
  if (process.platform === "darwin") {
    await kickstartLaunchd();
    if (await waitUp(15000)) return true;
  }
  spawnVite();
  return waitUp(20000);
}

function page(title, body) {
  const html = `<!doctype html><meta charset="utf-8"><title>Action Board</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b10;color:#e8e8f0;
font:15px -apple-system,BlinkMacSystemFont,sans-serif;text-align:center}h1{font-size:20px;font-weight:600}
p{color:#9a9ab0;max-width:520px}a{display:inline-block;margin-top:12px;padding:8px 18px;border-radius:8px;
background:linear-gradient(90deg,#4f7cff,#ff5fa2);color:#fff;text-decoration:none;font-weight:600}</style>
<div><h1>${title}</h1>${body}</div>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

async function connect() {
  if (starting) return;
  starting = true;
  win.loadURL(page("Starting the board...", `<p>Waiting for ${BASE}</p>`));
  serverUp = await ensureServer();
  starting = false;
  if (serverUp) {
    win.loadURL(BASE);
  } else {
    win.loadURL(
      page(
        "The board did not start",
        `<p>Nothing answered at ${BASE} after trying the launchd job (${LAUNCHD_LABEL}) and vite in ${path.join(BOARD_DIR, "app")}. ` +
          `Run ./start.sh in ~/action-board to see the error.</p><a href="${RETRY_URL}">Retry</a>`
      )
    );
  }
}

function isBoardUrl(url) {
  try {
    return new URL(url).origin === new URL(BASE).origin;
  } catch {
    return false;
  }
}

function openOutside(url) {
  if (/^https?:/i.test(url)) shell.openExternal(url);
}

function createWindow(show) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "Action Board",
    backgroundColor: "#0b0b10",
    show: false,
    icon: ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.on("page-title-updated", (e) => e.preventDefault());
  win.webContents.on("did-finish-load", () => refreshTabMenu());
  if (show) win.once("ready-to-show", () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isBoardUrl(url)) win.loadURL(url);
    else openOutside(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url === RETRY_URL || url === RETRY_URL + "/") {
      e.preventDefault();
      connect();
    } else if (!isBoardUrl(url)) {
      e.preventDefault();
      openOutside(url);
    }
  });

  // Closing hides; the app keeps running for the badge and notifications. Cmd+Q really quits.
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  app.focus({ steal: true });
}

function toggleWindow() {
  if (win && win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

function notify(card) {
  const { title, body } = notificationFor(card);
  const n = new Notification({ title, body, silent: false });
  liveNotifications.add(n);
  n.on("show", () => {
    notificationsShown += 1;
    lastNotificationEvent = "shown";
  });
  n.on("failed", (_e, err) => {
    lastNotificationEvent = "failed";
    lastNotificationError = String(err);
    console.log(`notification failed: ${err}`);
  });
  n.on("click", () => {
    lastNotificationEvent = "click";
    showWindow();
  });
  n.on("close", () => liveNotifications.delete(n));
  n.show();
  if (liveNotifications.size > 50) liveNotifications.delete(liveNotifications.values().next().value);
}

function writeStatus(openCount) {
  const status = {
    pid: process.pid,
    at: new Date().toISOString(),
    base: BASE,
    serverUp,
    openCount,
    badge: lastBadge,
    lastFreshIds,
    shortcut: SHORTCUT,
    shortcutRegistered,
    loginItem: process.platform === "darwin" ? app.getLoginItemSettings() : null,
    notificationSupported: Notification.isSupported(),
    notificationsShown,
    lastNotificationEvent,
    lastNotificationError,
  };
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.writeFileSync(path.join(USER_DATA, "status.json"), JSON.stringify(status, null, 2) + "\n");
  } catch (e) {
    console.log(`status write failed: ${e.message}`);
  }
}

let lastCount = null;
async function poll() {
  try {
    const res = await fetch(BOARD_URL, { signal: AbortSignal.timeout(2500), cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const board = await res.json();
    serverUp = true;
    const { count, badge, fresh } = tracker.update(board);
    if (count !== lastCount) {
      if (app.dock) app.dock.setBadge(badge);
      else app.setBadgeCount(count);
      lastBadge = badge;
      lastCount = count;
    }
    if (fresh.length) {
      lastFreshIds = fresh.map((c) => c.id);
      fresh.forEach(notify);
    }
  } catch {
    serverUp = false; // ignore; keep the last badge
  }
  writeStatus(lastCount);
}

function pollLoop() {
  poll().finally(() => setTimeout(pollLoop, POLL_MS));
}

// The Go menu lists the page's tabs (Cmd-1 = first tab, up to Cmd-9); it is absent until the page reports them.
function buildMenu(tabLabels = []) {
  const items = tabMenuItems(tabLabels);
  const go = {
    label: "Go",
    submenu: items.map(({ label, accelerator, index }) => ({
      label,
      accelerator,
      click: () => {
        showWindow();
        // select() refuses while a field has focus, so Cmd-2 in a text box does nothing.
        win.webContents
          .executeJavaScript(`window.actionBoardTabs && window.actionBoardTabs.select(${index})`)
          .catch(() => {});
      },
    })),
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      ...(items.length ? [go] : []),
      { role: "windowMenu" },
    ])
  );
}

// After each page load, read the tab labels out of the page and rebuild the menu if they changed.
// React mounts Tabs a moment after load, so an empty answer on the board is retried a few times.
let menuLabels = [];
async function refreshTabMenu(attempt = 0) {
  if (!win) return;
  let labels = [];
  try {
    const got = await win.webContents.executeJavaScript("window.actionBoardTabs ? window.actionBoardTabs.labels() : []");
    if (Array.isArray(got)) labels = got.map(String);
  } catch {
    labels = [];
  }
  if (!labels.length && attempt < 10 && isBoardUrl(win.webContents.getURL())) {
    setTimeout(() => refreshTabMenu(attempt + 1), 300);
    return;
  }
  if (JSON.stringify(labels) === JSON.stringify(menuLabels)) return;
  menuLabels = labels;
  buildMenu(labels);
}

function launchedHidden() {
  if (process.platform !== "darwin") return false;
  const s = app.getLoginItemSettings();
  return Boolean(s.wasOpenedAsHidden || s.wasOpenedAtLogin);
}

function start() {
  buildMenu();
  if (app.dock && !ICON.isEmpty()) app.dock.setIcon(ICON);
  if (app.isPackaged && process.platform === "darwin") app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });

  createWindow(!launchedHidden());

  shortcutRegistered = globalShortcut.register(SHORTCUT, toggleWindow);
  console.log(`global shortcut ${SHORTCUT} ${shortcutRegistered ? "registered" : "NOT registered"}`);

  app.on("activate", () => showWindow());
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());

  connect();
  pollLoop();
}
