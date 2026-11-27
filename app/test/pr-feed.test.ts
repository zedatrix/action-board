import { describe, expect, it } from "vitest";
import { commentsText, feedByLink, labelTint, lastUpdatedText, linkKey, normalizeItem, openReasons } from "../src/prFeed";
import { emptyFeed, isPrFeed } from "../src/feedTypes";
import { feedPr } from "./feed-pr";

describe("linkKey", () => {
  it("drops surrounding space, trailing slashes, #fragment and ?query, and ignores case", () => {
    const k = linkKey("https://github.com/acme/example-api/pull/731");
    for (const v of [" https://github.com/acme/example-api/pull/731/ ", "https://github.com/acme/example-api/pull/731#discussion_r1", "https://github.com/acme/example-api/pull/731/?x=1"])
      expect(linkKey(v)).toBe(k);
    expect(linkKey("https://github.com/acme/example-api/pull/732")).not.toBe(k);
    expect(linkKey(undefined)).toBe("");
  });
});

describe("normalizeItem and feedByLink", () => {
  it("coerces a bad row field by field instead of failing", () => {
    const p = normalizeItem({ link: "https://github.com/o/r/pull/1", number: 1, title: "T", ci: "exploded", labels: [{ name: "bug", color: 7 }, "x", { color: "fff" }], checks: null, comments: "9", unresolved: [{ author: "a", body: "b", url: "javascript:alert(1)" }], unresolved_count: 0 });
    expect(p).toMatchObject({ ci: "none", labels: [{ name: "bug", color: "" }], checks: { passed: 0, failed: 0, pending: 0 }, comments: 0, unresolved_count: 1, unresolved_more: false, head_oid: "", reviewers: [] });
    expect("body" in p!).toBe(false);
    expect(p!.unresolved[0]).toEqual({ author: "a", path: "", body: "b", url: "" });
    expect(normalizeItem({ link: "l", head_oid: 123, reviewers: null, unresolved_more: true }))
      .toMatchObject({ head_oid: "", reviewers: [], unresolved_more: true });
    expect(normalizeItem({ link: "l", unresolved_more: "yes" })!.unresolved_more).toBe(false);
    expect(normalizeItem("nope")).toBeNull();
    expect(normalizeItem({ number: 1 })).toBeNull();
  });

  it("reads the pre-change #731 cache row with empty reviewer facts", () => {
    const { link, number, title } = feedPr(731);
    const before: unknown = { ...emptyFeed(), prs: [{ link, number, title }] };
    if (!isPrFeed(before)) throw new Error("sample cache is invalid");
    const pr = feedByLink(before).get(linkKey(feedPr(731).link));
    expect(pr).toMatchObject({ number: 731, head_oid: "", reviewers: [] });
  });

  it("normalizes valid reviewer entries and drops malformed ones", () => {
    const p = normalizeItem({
      link: "l", head_oid: "123456789",
      reviewers: [
        null,
        { login: " ", state: "COMMENTED" },
        { login: "reviewer", state: "OTHER" },
        { login: " reviewer ", state: "APPROVED", at: "invalid", commit: "123456789", on_head: "yes", requested: true },
      ],
    });
    expect(p).toMatchObject({
      head_oid: "123456789",
      reviewers: [{ login: "reviewer", state: "APPROVED", at: "", commit: "12345678", on_head: false, requested: true }],
    });
  });

  it("keeps created_at, and reads an older cache row without it as empty", () => {
    expect(normalizeItem({ link: "l", created_at: "2026-11-20T08:30:00Z" })!.created_at).toBe("2026-11-20T08:30:00Z");
    expect(normalizeItem({ link: "l", number: 1, title: "T" })!.created_at).toBe("");
    expect(normalizeItem({ link: "l", created_at: 5 })!.created_at).toBe("");
  });

  it("maps PRs by linkKey, first one winning, and tolerates a missing list", () => {
    const m = feedByLink({ prs: [feedPr(1, { title: "first" }), feedPr(1, { title: "second" }), feedPr(2)] });
    expect([...m.keys()]).toEqual([linkKey(feedPr(1).link), linkKey(feedPr(2).link)]);
    expect(m.get(linkKey(feedPr(1).link))!.title).toBe("first");
    expect(feedByLink(null).size).toBe(0);
    expect(feedByLink({ prs: "x" as never }).size).toBe(0);
  });
});

describe("openReasons", () => {
  it("lists standing change requests before failing checks and open threads", () => {
    const Bob = { login: "bob", state: "CHANGES_REQUESTED", at: "", commit: "11111111", on_head: true, requested: false } as const;
    expect(openReasons(feedPr(1))).toEqual([]);
    expect(openReasons(feedPr(1, { reviewers: [Bob, { ...Bob, login: "another-user", requested: true }], failing_checks: 1, unresolved_count: 1 }))).toEqual([
      "changes requested by bob", "changes requested by another-user · re-review requested", "1 failing check", "1 open thread",
    ]);
    expect(openReasons(feedPr(1, { failing_checks: 3, unresolved_count: 12 }))).toEqual(["3 failing checks", "12 open threads"]);
    // An older feed without failing_checks still counts checks.failed.
    expect(openReasons(feedPr(1, { checks: { passed: 1, failed: 2, pending: 0 } }))).toEqual(["2 failing checks"]);
  });

  it("uses reviewer states when an older cache has only a PR-level decision", () => {
    expect(openReasons(normalizeItem({ link: "l", review_decision: "CHANGES_REQUESTED" })!)).toEqual([]);
  });

  it("says N+ open threads when the feed could not inspect all threads", () => {
    expect(openReasons(feedPr(1, { unresolved_count: 3, unresolved_more: true }))).toEqual(["3+ open threads"]);
    expect(openReasons(feedPr(1, { unresolved_count: 1, unresolved_more: true }))).toEqual(["1+ open threads"]);
    expect(openReasons(feedPr(1, { unresolved_count: 0, unresolved_more: true }))).toEqual(["0+ open threads"]);
  });

  it("says 1 comment and N comments", () => {
    expect([commentsText(1), commentsText(4)]).toEqual(["1 comment", "4 comments"]);
  });
});

describe("lastUpdatedText", () => {
  it("says Last updated h:mm AM/PM ET, in America/New_York through daylight saving time", () => {
    expect(lastUpdatedText("2026-11-26T20:49:00Z")).toBe("Last updated 3:49 PM ET");
    expect(lastUpdatedText("2026-11-26T15:04:00.000Z")).toBe("Last updated 10:04 AM ET");
    expect(lastUpdatedText("2026-07-01T04:05:00Z")).toBe("Last updated 12:05 AM ET");
    expect(lastUpdatedText("nope")).toBe("Last updated: unknown");
  });
});

describe("labelTint", () => {
  it("tints only RGB hex colors", () => {
    expect(labelTint("d73a4a")).toEqual({ backgroundColor: "rgba(215, 58, 74, 0.18)", borderColor: "rgba(215, 58, 74, 0.7)" });
    for (const bad of ["", "fff", "red;background:url(x)", "#d73a4a"]) expect(labelTint(bad)).toBeUndefined();
  });
});
