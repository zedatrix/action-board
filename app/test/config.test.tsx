// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Settings are read once at import, so each case loads fresh modules.
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("src/config.ts", () => {
  it("defaults to 'your assistant' and America/New_York", async () => {
    vi.stubEnv("ACTION_BOARD_ASSISTANT_NAME", "");
    vi.stubEnv("ACTION_BOARD_TIMEZONE", "");
    const { ASSISTANT_NAME, TIME_ZONE } = await import("../src/config");
    expect([ASSISTANT_NAME, TIME_ZONE]).toEqual(["your assistant", "America/New_York"]);
  });

  it("shows ACTION_BOARD_ASSISTANT_NAME on the Message button and in the composer", async () => {
    vi.stubEnv("ACTION_BOARD_ASSISTANT_NAME", " Ada ");
    const { MessageAssistant } = await import("../src/MessageAssistant");
    const item = { item_id: "i-1", item_section: "waiting" as const, item_title: "Signed NDA" };
    const noop = () => undefined;
    render(<MessageAssistant item={item} draft={{ text: "" }} latest={undefined} webhookConfigured onOpen={noop} onText={noop} onClose={noop} onSend={noop} />);
    expect(screen.getByRole("button", { name: "Message Ada about Signed NDA" }).textContent).toBe("Message Ada");
    expect(screen.getByRole("textbox", { name: "Message to Ada about Signed NDA" }).getAttribute("placeholder")).toBe("What should Ada know or do about this?");
  });

  it("formats card stamps in ACTION_BOARD_TIMEZONE", async () => {
    vi.stubEnv("ACTION_BOARD_TIMEZONE", "Europe/London");
    const { stampOf } = await import("../src/stamp");
    const s = stampOf({ created_at: "2026-11-13T15:00:00.000Z" }, new Date("2026-11-13T16:00:00.000Z"));
    expect(s).toMatchObject({ verb: "added", when: "3:00 PM", full: "Fri, Nov 13, 2026, 3:00 PM GMT" });
  });
});
