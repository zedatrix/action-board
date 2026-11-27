import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Todo, Todos } from "../src/data/types";
import { TODO_AUTHOR, todoRoute, TODO_ROUTE } from "../vite.config";

// POST /__ab/todo on a dev server whose root is a temp dir: its src/data/todos.ts is a temp list, and AB_BIN is
// the real bin/ab.mjs. The real todos.ts and board.ts are only read, for their wrapper text.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const A = "/* TODOS-JSON-START */";
const Z = "/* TODOS-JSON-END */";
const original = readFileSync(join(ROOT, "app/src/data/todos.ts"), "utf8");

const todo = (id: string, extra: Partial<Todo> = {}): Todo => ({
  id,
  name: `To-do ${id}`,
  priority: "medium",
  comments: [],
  created_at: "2026-11-20T09:00:00.000Z",
  updated_at: "2026-11-20T09:00:00.000Z",
  ...extra,
});

let root: string;
let file: string;
let vite: ViteDevServer;
let http: Server;
let base: string;
const savedBin = process.env.AB_BIN;
const savedTodos = process.env.AB_TODOS_FILE;

const seed = () => {
  const t: Todos = { updated_at: "2026-11-20T09:00:00.000Z", items: [todo("lease"), todo("old", { done_at: "2026-11-21T09:00:00.000Z" })] };
  writeFileSync(file, original.slice(0, original.indexOf(A) + A.length) + "\n" + JSON.stringify(t, null, 2) + "\n" + original.slice(original.indexOf(Z)));
};
const read = (): Todos => {
  const s = readFileSync(file, "utf8");
  return JSON.parse(s.slice(s.indexOf(A) + A.length, s.indexOf(Z)));
};
const find = (id: string) => read().items.find((x) => x.id === id);

async function startServer(abBin: string) {
  process.env.AB_BIN = abBin;
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [todoRoute()],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  const h = createHttpServer(server.middlewares);
  await new Promise<void>((resolve) => h.listen(0, "127.0.0.1", resolve));
  return { server, http: h, base: `http://127.0.0.1:${(h.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ab-todo-route-"));
  file = join(root, "src/data/todos.ts");
  mkdirSync(join(root, "src/data"), { recursive: true });
  writeFileSync(join(root, "src/data/board.ts"), readFileSync(join(ROOT, "app/src/data/board.ts"), "utf8"));
  // The route must point ab at its own todos.ts, whatever the environment says.
  process.env.AB_TODOS_FILE = join(root, "elsewhere.ts");
  ({ server: vite, http, base } = await startServer(join(ROOT, "bin/ab.mjs")));
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await vite.close();
  for (const [k, v] of [["AB_BIN", savedBin], ["AB_TODOS_FILE", savedTodos]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(seed);

const post = (body: unknown, headers: Record<string, string> = {}, url = base) =>
  fetch(`${url}${TODO_ROUTE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }).then(async (r) => [r.status, await r.text()] as const);
const ok = async (body: unknown) => {
  const [status, text] = await post(body, { Origin: "http://board.localhost:8085" });
  expect([status, text]).toEqual([200, expect.any(String)]);
  const r = JSON.parse(text);
  expect(Object.keys(r)).toEqual(["ok", "todo"]);
  expect(r.ok).toBe(true);
  return r.todo as Todo;
};
const rawPost = (host: string, body: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request(`${base}${TODO_ROUTE}`, { method: "POST", agent: false, headers: { Host: host, "Content-Type": "application/json" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
const NO = JSON.stringify({ ok: false });

// Runs a refused request and checks that todos.ts did not change at all.
async function refused(code: number, send: () => Promise<number | readonly [number, string]>) {
  const before = readFileSync(file, "utf8");
  const r = await send();
  if (typeof r === "number") expect(r).toBe(code);
  else expect(r).toEqual([code, NO]);
  expect(readFileSync(file, "utf8")).toBe(before);
}

describe("POST /__ab/todo", () => {
  it("add: runs ab todo-add (quick parsed by ab) and replies with the stored to-do", async () => {
    const text = readFileSync(file, "utf8");
    const t = await ok({ action: "add", quick: "call the vendor Friday 3pm p1" });
    expect(t).toMatchObject({ name: "call the vendor Friday 3pm", priority: "urgent", comments: [] });
    expect(t).not.toHaveProperty("due");
    expect(t.id).toMatch(/^call-the-vendor-friday-3pm-[0-9a-f]{6}$/);
    expect(find(t.id)).toEqual(t);
    expect(read().items.map((x) => x.id)).toEqual(["lease", "old", t.id]);
    // The wrapper outside the markers is untouched; ab logged it next to the app.
    const now = readFileSync(file, "utf8");
    expect(now.slice(0, now.indexOf(A))).toBe(text.slice(0, text.indexOf(A)));
    expect(now.slice(now.indexOf(Z))).toBe(text.slice(text.indexOf(Z)));
    expect(readFileSync(join(root, ".ab-log.jsonl"), "utf8")).toContain(`"op":"todo-add","id":"${t.id}"`);

    const sub = await ok({ action: "add", name: "Find the lease PDF", parent_id: "lease", priority: "high" });
    expect(sub).toMatchObject({ name: "Find the lease PDF", parent_id: "lease", priority: "high" });
  });

  it("update, comment (always by User), done and reopen", async () => {
    expect(await ok({ action: "update", id: "lease", description: "Renewal terms", due: { date: "2026-12-01", time: "09:30" } })).toMatchObject({
      id: "lease",
      description: "Renewal terms",
      due: { date: "2026-12-01", time: "09:30" },
    });

    const c = await ok({ action: "comment", id: "lease", text: "  Landlord says Monday  " });
    expect(c.due).toEqual({ date: "2026-12-01", time: "09:30" });
    expect(TODO_AUTHOR).toBe("User");
    expect(c.comments).toEqual([{ id: expect.stringMatching(/^c-[0-9a-f]{8}$/), text: "Landlord says Monday", author: "User", at: expect.any(String) }]);

    const done = await ok({ action: "done", id: "lease" });
    expect(Date.parse(done.done_at!)).not.toBeNaN();
    expect(await ok({ action: "done", id: "lease" })).toEqual(done);
    expect(await ok({ action: "reopen", id: "lease" })).not.toHaveProperty("done_at");
    expect(find("lease")).not.toHaveProperty("done_at");
    expect(find("lease")?.due).toEqual({ date: "2026-12-01", time: "09:30" });
  });

  it("maps an unknown id to 404 and ab's refusals to 400", async () => {
    for (const action of ["update", "comment", "done", "reopen"]) {
      const extra = action === "update" ? { name: "x" } : action === "comment" ? { text: "x" } : {};
      await refused(404, () => post({ action, id: "nope", ...extra }));
    }
    for (const body of [
      { action: "add", name: " " },
      { action: "add", quick: "p1" },
      { action: "add", name: "x", priority: "p1" },
      { action: "add", name: "x", due: { date: "2026-02-30" } },
      { action: "add", name: "x", parent_id: "nope" },
      { action: "add", name: "x".repeat(201) },
      { action: "update", id: "lease" },
      { action: "update", id: "lease", parent_id: "lease" },
      { action: "comment", id: "lease", text: "  " },
      { action: "add" },
    ])
      await refused(400, () => post(body));
  });

  it("refuses a bad body with 400 without running ab", async () => {
    for (const body of [
      { action: "delete", id: "lease" },
      { action: "toString", id: "lease" },
      { id: "lease" },
      { action: 3, id: "lease" },
      { action: "done" },
      { action: "done", id: "" },
      { action: "done", id: 3 },
      { action: "done", id: "lease", extra: true },
      { action: "comment", id: "lease", text: "Hi", author: "Assistant" },
      { action: "add", name: "x", id: "chosen-id" },
      ["done", "lease"],
      null,
      "not json",
    ])
      await refused(400, () => post(body as unknown));
    await refused(400, () => post({ action: "add", name: "x", description: "x".repeat(17 * 1024) }).catch(() => [400, NO] as const));
  });

  it("refuses other methods (405), foreign hosts and origins (403) and non-JSON bodies (415)", async () => {
    const get = await fetch(`${base}${TODO_ROUTE}`);
    expect([get.status, await get.text()]).toEqual([405, NO]);
    const body = JSON.stringify({ action: "done", id: "lease" });
    await refused(403, () => rawPost("evil.example:8085", body));
    await refused(403, () => rawPost("board.localhost.evil.example", body));
    for (const origin of ["https://evil.example", "http://board.localhost.evil.example:8085", "null"])
      await refused(403, () => post({ action: "done", id: "lease" }, { Origin: origin }));
    await refused(415, () => post({ action: "done", id: "lease" }, { "Content-Type": "text/plain" }));
  });

  it("answers 502 with only {ok:false} when ab fails another way or prints something unexpected", async () => {
    for (const script of ['console.error("secret detail http://hook.example/x"); process.exit(7);\n', 'console.log("not json");\n']) {
      const bin = join(root, "broken-ab.mjs");
      writeFileSync(bin, script);
      const other = await startServer(bin);
      try {
        await refused(502, () => post({ action: "done", id: "lease" }, {}, other.base));
      } finally {
        process.env.AB_BIN = join(ROOT, "bin/ab.mjs");
        await new Promise<void>((resolve) => other.http.close(() => resolve()));
        await other.server.close();
      }
    }
  });
});
