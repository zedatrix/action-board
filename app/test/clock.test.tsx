// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";
import { NOW_MS, useNow } from "../src/useNow";

// 04:59 UTC on Nov 13 2026 is 11:59 PM EST on Thu Nov 12.
const BEFORE_MIDNIGHT = "2026-11-13T04:59:00.000Z";

const d = (id: string) => ({
  id,
  card_ref: null,
  question: `Question ${id}?`,
  what_happens_after: "Something happens.",
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  created_at: BEFORE_MIDNIGHT,
  updated_at: BEFORE_MIDNIGHT,
});

vi.mock("../src/data/board", () => ({
  board: { updated_at: "2026-11-13T04:59:00.000Z", decisions: [d("one"), d("two")], glance: { waiting: [], tickets: [] } } satisfies Board,
}));

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", "");
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in tests"))));
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BEFORE_MIDNIGHT));
});
afterEach(() => {
  cleanup();
  // Before useRealTimers: the spies wrap the fake timer functions.
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const stamps = () => [...document.querySelectorAll("[data-decision-id] .stamp")].map((e) => e.textContent);

describe("card stamps on the shared clock (useNow in App)", () => {
  it("add the date once midnight Eastern passes, with no new board data and no reload", async () => {
    const { default: App } = await import("../src/App");
    render(<App />);
    expect(stamps()).toEqual(["added 11:59 PM", "added 11:59 PM"]);

    act(() => void vi.advanceTimersByTime(2 * 60_000));
    expect(stamps()).toEqual(["added Nov 12, 11:59 PM", "added Nov 12, 11:59 PM"]);
  });

  it("rolls the header date over at midnight Eastern on the same single clock", async () => {
    // 04:59:30 UTC on Nov 14 2026 is 11:59:30 PM EST on Fri Nov 13.
    vi.setSystemTime(new Date("2026-11-14T04:59:30.000Z"));
    const setInterval = vi.spyOn(window, "setInterval");
    const { default: App } = await import("../src/App");
    render(<App />);
    const header = () => document.querySelector(".top-meta")?.textContent;
    // In jsdom there is no EventSource, so the live board also polls on its own interval; only one is the clock.
    const clocks = () => setInterval.mock.calls.filter(([, ms]) => ms === NOW_MS).length;

    expect(header()).toBe("Fri 13 Nov · local");
    const timers = vi.getTimerCount();
    const intervals = setInterval.mock.calls.length;
    expect(clocks()).toBe(1);

    act(() => void vi.advanceTimersByTime(60_000));
    expect(header()).toBe("Sat 14 Nov · local");
    expect(clocks()).toBe(1);
    expect(setInterval.mock.calls.length).toBe(intervals);
    expect(vi.getTimerCount()).toBe(timers);
  });
});

describe("useNow", () => {
  it("ticks every 60s", () => {
    const { result } = renderHook(() => useNow());
    const start = result.current;
    expect(NOW_MS).toBe(60_000);

    act(() => void vi.advanceTimersByTime(59_999));
    expect(result.current).toBe(start);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current.getTime()).toBe(start.getTime() + 60_000);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(result.current.getTime()).toBe(start.getTime() + 120_000);
  });

  it("runs one interval and clears it on unmount", () => {
    const clear = vi.spyOn(window, "clearInterval");
    const { unmount } = renderHook(() => useNow());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
