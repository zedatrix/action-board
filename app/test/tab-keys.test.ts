// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isEditableTarget, tabIndexForKey } from "../src/tabKeys";

const cmd = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("tabIndexForKey", () => {
  it("maps Cmd-1..3 to the three tabs and nothing past them", () => {
    expect(tabIndexForKey(cmd("1"), 3)).toBe(0);
    expect(tabIndexForKey(cmd("2"), 3)).toBe(1);
    expect(tabIndexForKey(cmd("3"), 3)).toBe(2);
    expect(tabIndexForKey(cmd("4"), 3)).toBeNull();
  });

  it("follows a longer tab list", () => {
    expect(tabIndexForKey(cmd("4"), 5)).toBe(3);
    expect(tabIndexForKey(cmd("5"), 5)).toBe(4);
    expect(tabIndexForKey(cmd("6"), 5)).toBeNull();
  });

  it("ignores Cmd-0, other modifiers, plain digits and other keys", () => {
    expect(tabIndexForKey(cmd("0"), 5)).toBeNull();
    expect(tabIndexForKey(cmd("2", { shiftKey: true }), 5)).toBeNull();
    expect(tabIndexForKey(cmd("2", { altKey: true }), 5)).toBeNull();
    expect(tabIndexForKey(cmd("2", { ctrlKey: true }), 5)).toBeNull();
    expect(tabIndexForKey(cmd("2", { metaKey: false, ctrlKey: true }), 5)).toBeNull();
    expect(tabIndexForKey(cmd("2", { metaKey: false }), 5)).toBeNull();
    expect(tabIndexForKey(cmd("a"), 5)).toBeNull();
    expect(tabIndexForKey(cmd("12"), 20)).toBeNull();
  });
});

describe("isEditableTarget", () => {
  const el = (html: string) => {
    document.body.innerHTML = html;
    return document.body.querySelector("[data-t]");
  };

  it("is true for fields and contenteditable", () => {
    expect(isEditableTarget(el('<input data-t>'))).toBe(true);
    expect(isEditableTarget(el("<textarea data-t></textarea>"))).toBe(true);
    expect(isEditableTarget(el("<select data-t></select>"))).toBe(true);
    expect(isEditableTarget(el('<div contenteditable="true" data-t></div>'))).toBe(true);
    expect(isEditableTarget(el('<div contenteditable data-t></div>'))).toBe(true);
    expect(isEditableTarget(el('<div contenteditable="true"><p><span data-t>x</span></p></div>'))).toBe(true);
  });

  it("is false for buttons, plain elements, contenteditable=false and null", () => {
    expect(isEditableTarget(el("<button data-t>Go</button>"))).toBe(false);
    expect(isEditableTarget(el("<div data-t>x</div>"))).toBe(false);
    expect(isEditableTarget(el('<div contenteditable="false" data-t></div>'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
  });
});
