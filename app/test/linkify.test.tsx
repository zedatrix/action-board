// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { bareUrl, linkify } from "../src/linkify";

afterEach(cleanup);

const links = (text: string) => {
  const { container } = render(<p>{linkify(text)}</p>);
  expect(container.textContent).toBe(text);
  return [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
};

describe("linkify", () => {
  it("returns plain text untouched", () => {
    expect(linkify("PROJ-4382 is open.")).toEqual(["PROJ-4382 is open."]);
    expect(linkify("")).toEqual([]);
  });

  it("finds several URLs and trims trailing punctuation", () => {
    expect(links("a https://example.com/a, b http://y.io/b; c (https://z.io/c). d https://w.io/d?!")).toEqual([
      "https://example.com/a",
      "http://y.io/b",
      "https://z.io/c",
      "https://w.io/d",
    ]);
  });

  it("keeps query strings and fragments", () => {
    expect(links("go to https://example.com/p?a=1&b=2#top now")).toEqual(["https://example.com/p?a=1&b=2#top"]);
  });

  it("ignores a bare scheme and non-http schemes", () => {
    expect(links("https://. and ftp://x.io and javascript:alert(1)")).toEqual([]);
  });
});

describe("bareUrl", () => {
  it("accepts a whole-text URL and rejects anything else", () => {
    expect(bareUrl("https://github.com/acme/example/pull/1800")).toBe("https://github.com/acme/example/pull/1800");
    expect(bareUrl(" https://example.com/a ")).toBe("https://example.com/a");
    expect(bareUrl("PROJ-4382")).toBeNull();
    expect(bareUrl("https://example.com/a.")).toBeNull();
    expect(bareUrl("see https://example.com/a")).toBeNull();
  });
});
