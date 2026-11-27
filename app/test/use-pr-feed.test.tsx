// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyFeed, type PrFeed } from "../src/feedTypes";
import { feedOf, feedPr } from "./feed-pr";

// A stand-in for the browser's EventSource that the test drives by hand.
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  constructor(public url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  send(event: string, data: string) {
    this.dispatchEvent(new MessageEvent(event, { data }));
  }
  fail() {
    this.readyState = 0;
    this.dispatchEvent(new Event("error"));
  }
}

let served: unknown;
let fetchMock: ReturnType<typeof vi.fn>;
const feedFetches = () => fetchMock.mock.calls.filter(([url]) => url === "/__ab/feed").length;

beforeEach(() => {
  vi.resetModules();
  FakeEventSource.instances = [];
  served = feedOf([feedPr(1)]);
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/__ab/feed") return new Response(typeof served === "string" ? served : JSON.stringify(served), { status: 200 });
    throw new Error("no network in tests");
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  const { usePrFeed, FEED_PATH, FEED_POLL_MS } = await import("../src/usePrFeed");
  expect([FEED_PATH, FEED_POLL_MS]).toEqual(["/__ab/feed", 10_000]);
  return renderHook(() => usePrFeed());
}
const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});

describe("usePrFeed", () => {
  it("without EventSource: starts empty, fetches /__ab/feed at once, then every 10 seconds", async () => {
    vi.stubGlobal("EventSource", undefined);
    vi.useFakeTimers();
    const { result } = await mount();
    expect(result.current).toEqual(emptyFeed());
    await flush();
    expect(feedFetches()).toBe(1);
    expect(result.current.prs.map((p) => p.number)).toEqual([1]);
    served = feedOf([feedPr(1), feedPr(2)]);
    await act(() => vi.advanceTimersByTimeAsync(9_000));
    expect(feedFetches()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(feedFetches()).toBe(2);
    expect(result.current.prs.map((p) => p.number)).toEqual([1, 2]);
  });

  it("ignores a bad shape or bad JSON and keeps the last good feed", async () => {
    vi.stubGlobal("EventSource", undefined);
    vi.useFakeTimers();
    const { result } = await mount();
    await flush();
    const good = result.current;
    for (const bad of ["{not json", JSON.stringify({ prs: "x" }), JSON.stringify({ ...feedOf([]), prs: [{ link: 5 }] }), "null"]) {
      served = bad;
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(result.current).toBe(good);
    }
  });

  it("follows feed events on /__ab/events, polls only while the stream is down, and refetches on focus", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
    const { result } = await mount();
    const es = FakeEventSource.instances[0];
    expect(es.url).toBe("/__ab/events");
    act(() => es.open());
    expect(feedFetches()).toBe(0);

    const next: PrFeed = feedOf([feedPr(3)]);
    act(() => es.send("feed", JSON.stringify(next)));
    expect(result.current).toEqual(next);
    // Other events are not the feed.
    act(() => es.send("board", JSON.stringify(feedOf([feedPr(4)]))));
    expect(result.current).toEqual(next);

    // Stream down: fetch now and every 10 seconds, until it is back.
    act(() => es.fail());
    await flush();
    expect(feedFetches()).toBe(1);
    expect(result.current.prs.map((p) => p.number)).toEqual([1]);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(feedFetches()).toBe(2);
    act(() => es.open());
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(feedFetches()).toBe(2);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(feedFetches()).toBe(3);
  });
});

describe("useFeedRefresh", () => {
  const refreshes = () => fetchMock.mock.calls.filter(([url]) => url === "/__ab/feed/refresh");
  const setVisibility = (v: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  afterEach(() => {
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  async function mountRefresh(shown: boolean) {
    const { useFeedRefresh, FEED_REFRESH_PATH, REFRESH_DEBOUNCE_MS } = await import("../src/usePrFeed");
    expect([FEED_REFRESH_PATH, REFRESH_DEBOUNCE_MS]).toEqual(["/__ab/feed/refresh", 30_000]);
    return renderHook(({ shown }) => useFeedRefresh(shown), { initialProps: { shown } });
  }

  it("posts when shown, then on focus and on becoming visible, at most once every 30 seconds", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-26T15:00:00Z") });
    await mountRefresh(true);
    expect(refreshes()).toHaveLength(1);
    expect(refreshes()[0][1]).toMatchObject({ method: "POST" });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(refreshes()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(29_999));
    act(() => setVisibility("visible"));
    expect(refreshes()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(refreshes()).toHaveLength(2);
    act(() => vi.advanceTimersByTime(30_000));
    act(() => setVisibility("hidden"));
    expect(refreshes()).toHaveLength(2);
    act(() => setVisibility("visible"));
    expect(refreshes()).toHaveLength(3);
  });

  it("does nothing while not shown, posts when shown, and ignores a failed call", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-26T15:00:00Z") });
    const { rerender, unmount } = await mountRefresh(false);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    act(() => setVisibility("visible"));
    expect(refreshes()).toHaveLength(0);
    // The test fetch throws for this path: the hook swallows it.
    rerender({ shown: true });
    expect(refreshes()).toHaveLength(1);
    await flush();
    // Hidden again, then shown within 30 seconds: debounced; after 30 seconds: posted.
    rerender({ shown: false });
    rerender({ shown: true });
    expect(refreshes()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(30_000));
    rerender({ shown: false });
    rerender({ shown: true });
    expect(refreshes()).toHaveLength(2);
    unmount();
    act(() => vi.advanceTimersByTime(30_000));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(refreshes()).toHaveLength(2);
  });
});
