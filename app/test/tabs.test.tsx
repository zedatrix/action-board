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
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Board", "PRs", "Website relaunch"]);
    expect(selected()).toEqual(["Board"]);
    expect(tab("Board").tabIndex).toBe(0);
    expect(tab("PRs").tabIndex).toBe(-1);
    expect(tab("Website relaunch").tabIndex).toBe(-1);
    expect(tab("PRs").getAttribute("aria-controls")).toBe("panel-prs");
    // The to-do list sits on the Board; the PR sections are on the hidden PRs tab.
    expect(document.getElementById("panel-board")!.querySelector(".todos")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: /^Hotfixes/ })).toBeNull();
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

  it("switches to PRs and back, keeping the choice in the hash and the Board mounted", async () => {
    await renderTabs();
    fireEvent.click(tab("PRs"));
    expect(selected()).toEqual(["PRs"]);
    expect(window.location.hash).toBe("#prs");
    expect(screen.getByRole("tabpanel").id).toBe("panel-prs");
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Hotfixes 0",
      "Non-project PRs 0",
      "Project PRs 0",
      "Tickets with no PR yet 0",
      "Review requests 0",
      "Other repos 0",
    ]);
    expect(screen.queryByRole("heading", { name: /Needs you/ })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector('[data-decision-id="single"]')).not.toBeNull();

    fireEvent.click(tab("Board"));
    expect(selected()).toEqual(["Board"]);
    expect(window.location.hash).toBe("");
    expect(screen.queryByRole("heading", { name: /^Hotfixes/ })).toBeNull();
  });

  it("opens on PRs when the page loads with #prs", async () => {
    window.history.replaceState(null, "", "/#prs");
    await renderTabs();
    expect(selected()).toEqual(["PRs"]);
    expect(screen.getByRole("heading", { name: /^Hotfixes/ })).toBeTruthy();
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
      window.location.hash = "#prs";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(selected()).toEqual(["PRs"]);
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
    expect(selected()).toEqual(["PRs"]);
    expect(document.activeElement).toBe(tab("PRs"));
    fireEvent.keyDown(tab("PRs"), { key: "ArrowRight" });
    expect(selected()).toEqual(["Website relaunch"]);
    expect(document.activeElement).toBe(tab("Website relaunch"));
    fireEvent.keyDown(tab("Website relaunch"), { key: "ArrowRight" });
    expect(selected()).toEqual(["Board"]);
    fireEvent.keyDown(tab("Board"), { key: "ArrowLeft" });
    expect(selected()).toEqual(["Website relaunch"]);
    fireEvent.keyDown(tab("Website relaunch"), { key: "Home" });
    expect(selected()).toEqual(["Board"]);
    fireEvent.keyDown(tab("Board"), { key: "End" });
    expect(selected()).toEqual(["Website relaunch"]);
    fireEvent.keyDown(tab("Website relaunch"), { key: "Home" });
    expect(selected()).toEqual(["Board"]);
    expect(document.activeElement).toBe(tab("Board"));
  });

  it("opens tabs with Cmd-1..3 in tab order, keeping the hash", async () => {
    await renderTabs();
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(selected()).toEqual(["PRs"]);
    expect(window.location.hash).toBe("#prs");
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(selected()).toEqual(["Board"]);
    expect(window.location.hash).toBe("");
    fireEvent.keyDown(document.body, { key: "3", metaKey: true });
    expect(selected()).toEqual(["Website relaunch"]);
    expect(window.location.hash).toBe("#project");
    fireEvent.keyDown(window, { key: "4", metaKey: true });
    fireEvent.keyDown(window, { key: "1" });
    expect(selected()).toEqual(["Website relaunch"]);
  });

  it("ignores Cmd-digits while a field has focus", async () => {
    await renderTabs();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "2", metaKey: true });
    expect(selected()).toEqual(["Board"]);
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(selected()).toEqual(["Board"]);
    expect(window.actionBoardTabs!.select(1)).toBe(false);
    expect(selected()).toEqual(["Board"]);
    input.remove();
  });

  it("exposes the tabs to the desktop app as window.actionBoardTabs", async () => {
    await renderTabs();
    const api = window.actionBoardTabs!;
    expect(api.labels()).toEqual(screen.getAllByRole("tab").map((t) => t.textContent));
    act(() => {
      expect(api.select(1)).toBe(true);
    });
    expect(selected()).toEqual(["PRs"]);
    expect(window.location.hash).toBe("#prs");
    expect(api.select(9)).toBe(false);
    expect(api.select(-1)).toBe(false);
    expect(selected()).toEqual(["PRs"]);
    cleanup();
    expect(window.actionBoardTabs).toBeUndefined();
  });
});
