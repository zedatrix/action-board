import { captureCommand } from "./capture-command";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// The link guard on `ab raise`, run with the real bin/ab.mjs against a temp copy of board.ts (never the real one).
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ab-link-guard-"));
const file = join(dir, "app/src/data/board.ts");
mkdirSync(join(dir, "app/src/data"), { recursive: true });
copyFileSync(join(ROOT, "app/src/data/board.ts"), file);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const A = "/* BOARD-JSON-START */";
const Z = "/* BOARD-JSON-END */";
const ab = (...args: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, AB_FILE: file, AB_NO_SERVER: "1" };
  delete env.AB_URL;
  const r = captureCommand("node", [join(ROOT, "bin/ab.mjs"), ...args], { env, timeout: 10000 });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const find = (id: string) => {
  const s = readFileSync(file, "utf8");
  return JSON.parse(s.slice(s.indexOf(A) + A.length, s.indexOf(Z))).decisions.find((d: { id: string }) => d.id === id);
};
const card = (id: string, card_ref: string | null, link?: unknown) => JSON.stringify({
  id, title: "Link guard card", card_ref, ...(link === undefined ? {} : { link }),
  context: "Test card for the link guard, standing in for a real PR or ticket that needs a call.",
  question: "Ship the link guard test card?", what_happens_after: "Nothing real.",
  options: [{ id: "a", label: "A" }], blocking: false,
});

const GH = "link must be a GitHub PR URL of the form https://github.com/<owner>/<repo>/pull/<number>, got";
const LN = "link must be a Linear issue URL of the form https://linear.app/<workspace>/issue/<KEY-N>, got";
const refusals: [string, string | null, string | undefined, string][] = [
  ["http:// GitHub link", null, "http://github.com/acme/example-web/pull/11550", `${GH} http://github.com/acme/example-web/pull/11550 (it must use https://)`],
  ["GitHub link, invalid owner", null, "https://github.com/bad_owner/example-web/pull/11550", `${GH} https://github.com/bad_owner/example-web/pull/11550 (the owner is missing or invalid)`],
  ["GitHub issues/ path", null, "https://github.com/acme/example-web/issues/11550", `${GH} https://github.com/acme/example-web/issues/11550 (it must be a /pull/ URL, not /issues/)`],
  ["GitHub tree/ path", null, "https://github.com/acme/example-web/tree/main", `${GH} https://github.com/acme/example-web/tree/main (it must be a /pull/ URL, not /tree/)`],
  ["GitHub link, no PR number", null, "https://github.com/acme/example-web/pull/", `${GH} https://github.com/acme/example-web/pull/ (the PR number is missing)`],
  ["Linear invalid workspace", null, "https://linear.app/bad_workspace/issue/PROJ-15054", `${LN} https://linear.app/bad_workspace/issue/PROJ-15054 (the workspace is missing or invalid)`],
  ["look-alike github.com.example.com", null, "https://github.com.example.com/acme/example-web/pull/11550", `${GH} https://github.com.example.com/acme/example-web/pull/11550 (the host must be exactly github.com)`],
  ["look-alike linear.app@x", null, "https://linear.app@example.com/acme/issue/PROJ-15054", `${LN} a URL with user:password@ (it has credentials before the host)`],
  ["bad card_ref URL, no link", "https://github.com/acme/example-web/issues/11550", undefined, "card_ref must be a GitHub PR URL of the form https://github.com/<owner>/<repo>/pull/<number>, got https://github.com/acme/example-web/issues/11550 (it must be a /pull/ URL, not /issues/)"],
  ["PR number mismatch", "#11550", "https://github.com/acme/example-web/pull/731", "link PR number 731 does not match card_ref #11550"],
  ["repo mismatch", "example-api#11550", "https://github.com/acme/example-web/pull/11550", "link repo example-web does not match card_ref example-api#11550"],
  ["kind mismatch (PR ref, Linear link)", "#11550", "https://linear.app/example-team/issue/PROJ-11550", "link is a Linear issue URL but card_ref #11550 is a PR; use https://github.com/<owner>/<repo>/pull/11550"],
  ["ticket key mismatch", "PROJ-15054", "https://linear.app/example-team/issue/PROJ-15055", "link ticket PROJ-15055 does not match card_ref PROJ-15054"],
  ["bare ref, non-PR link", "#11550", "https://example.com/pr/11550", "link must be a GitHub PR URL for card_ref #11550 (https://github.com/<owner>/<repo>/pull/11550), got https://example.com/pr/11550"],
];
const allowed: [string, string | null, string | undefined][] = [
  ["good PR URL", "example-web#11550", "https://github.com/acme/example-web/pull/11550"],
  ["good PR URL with /files?x#y", "#11550", "https://github.com/acme/example-web/pull/11550/files?w=1#top"],
  ["good Linear URL (example-team)", "PROJ-15054", "https://linear.app/example-team/issue/PROJ-15054/emergency-contact"],
  ["good Linear URL (alternate workspace)", "PROJ-15054", "https://linear.app/acme/issue/PROJ-15054"],
  ["bare PR ref, no link", "example-web#11550", undefined],
  ["ticket key, no link", "PROJ-14382", undefined],
  ["null card_ref, no link", null, undefined],
  ["plain-words card_ref", "Coolify preview", undefined],
  ["URL on another host", "https://example.com/messages/1", undefined],
  ["link only (fills card_ref)", null, "https://github.com/acme/example-api/pull/11764"],
];

describe("ab raise link guard", () => {
  it.each(refusals)("refuses %s: exit 2, the message, board.ts byte-identical", (_name, ref, link, msg) => {
    const before = readFileSync(file);
    const r = ab("raise", card("t-lg-bad", ref, link));
    expect(r.status).toBe(2);
    expect(r.err).toBe(`ab: raise: ${msg}\n`);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it.each(allowed)("allows %s", (name, ref, link) => {
    const id = "t-lg-" + name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/-+$/, "");
    const r = ab("raise", card(id, ref, link));
    expect([r.status, r.err]).toEqual([0, ""]);
    const d = find(id);
    expect(d.card_ref).toBe(ref ?? link ?? null);
    if (link === undefined) expect(d).not.toHaveProperty("link");
    else expect(d.link).toBe(link);
    expect(JSON.parse(r.out).card.link).toBe(link ?? ref);
  });

  it("validates a re-raise of an existing card too", () => {
    expect(ab("raise", card("t-lg-reraise", "#11550", "https://github.com/acme/example-web/pull/11550")).status).toBe(0);
    const before = readFileSync(file);
    const r = ab("raise", card("t-lg-reraise", "#11550", "https://github.com/acme/example-web/pull/731"));
    expect(r.status).toBe(2);
    expect(r.err).toBe("ab: raise: link PR number 731 does not match card_ref #11550\n");
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(find("t-lg-reraise").link).toBe("https://github.com/acme/example-web/pull/11550");
  });

  it("refuses a link that is not a non-blank string", () => {
    for (const link of [11550, "  ", ["x"]]) {
      const before = readFileSync(file);
      const r = ab("raise", card("t-lg-type", null, link));
      expect(r.status).toBe(2);
      expect(r.err).toMatch(/^ab: raise: link must be a non-blank string/);
      expect(readFileSync(file).equals(before)).toBe(true);
    }
  });

  it("leaves lint clean with link stored on cards", () => {
    const r = ab("lint");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out).failing).toEqual([]);
  });
});
