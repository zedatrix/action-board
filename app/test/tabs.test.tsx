// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";

// A small board instead of the real board.ts; the Board tab only has to show it.
vi.mock("../src/data/board", () => ({
  board: {
    updated_at: "2026-11-10T09:00:00.000Z",
    decisions: [
      {
        id: "single",
        card_ref: null,
        question: "Question single?",
        what_happens_after: "Something happens.",
        options: [{ id: "yes", label: "Yes" }],
        created_at: "2026-11-10T09:00:00.000Z",
      },
    ],
    glance: { waiting: [], tickets: [] },
  } satisfies Board,
}));

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", "");
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in tests"))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function renderTabs() {
  const { default: Tabs } = await import("../src/Tabs");
  render(<Tabs />);
}
const tab = (name: string) => screen.getByRole("tab", { name });
const selected = () => screen.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent);

describe("Tabs", () => {
  it("shows the Board by default, with the project table hidden", async () => {
    await renderTabs();
    expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe("Views");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Board", "Website relaunch"]);
    expect(selected()).toEqual(["Board"]);
    expect(tab("Board").tabIndex).toBe(0);
    expect(tab("Website relaunch").tabIndex).toBe(-1);
    expect(screen.getByRole("heading", { name: /Needs you\s*1/ })).toBeTruthy();
    expect(document.querySelector('[data-decision-id="single"]')).not.toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("tabpanel").id).toBe("panel-board");
    expect(window.location.hash).toBe("");
  });

  it("switches to Website relaunch and back, keeping the choice in the hash", async () => {
    await renderTabs();
    fireEvent.click(tab("Website relaunch"));
    expect(selected()).toEqual(["Website relaunch"]);
    expect(window.location.hash).toBe("#project");
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByRole("tabpanel").id).toBe("panel-project");
    expect(screen.queryByRole("heading", { name: /Needs you/ })).toBeNull();
    // The Board stays mounted while hidden, so its state survives the switch.
    expect(document.querySelector('[data-decision-id="single"]')).not.toBeNull();

    fireEvent.click(tab("Board"));
    expect(selected()).toEqual(["Board"]);
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("opens on Website relaunch when the page loads with #project", async () => {
    window.history.replaceState(null, "", "/#project");
    await renderTabs();
    expect(selected()).toEqual(["Website relaunch"]);
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("follows a hash change, and any other hash means Board", async () => {
    await renderTabs();
    await act(async () => {
      window.location.hash = "#project";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(selected()).toEqual(["Website relaunch"]);
    await act(async () => {
      window.location.hash = "#other";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(selected()).toEqual(["Board"]);
  });

  it("moves between tabs with the arrow keys, Home and End", async () => {
    await renderTabs();
    tab("Board").focus();
    fireEvent.keyDown(tab("Board"), { key: "ArrowRight" });
    expect(selected()).toEqual(["Website relaunch"]);
    expect(document.activeElement).toBe(tab("Website relaunch"));
    fireEvent.keyDown(tab("Website relaunch"), { key: "ArrowRight" });
    expect(selected()).toEqual(["Board"]);
    fireEvent.keyDown(tab("Board"), { key: "End" });
    expect(selected()).toEqual(["Website relaunch"]);
    fireEvent.keyDown(tab("Website relaunch"), { key: "Home" });
    expect(selected()).toEqual(["Board"]);
    expect(document.activeElement).toBe(tab("Board"));
  });
});
