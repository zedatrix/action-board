import { afterEach, describe, expect, it, vi } from "vitest";

// vite.config.ts reads the host and port once at import, so each case loads it fresh.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("vite.config.ts host and port", () => {
  it("defaults to board.localhost on 8085, with localhost and 127.0.0.1 always allowed", async () => {
    vi.stubEnv("ACTION_BOARD_HOST", "");
    vi.stubEnv("ACTION_BOARD_PORT", "");
    const cfg = await import("../vite.config");
    const { server } = cfg.default({ command: "serve", mode: "development" });
    expect([cfg.BOARD_HOST, cfg.BOARD_PORT]).toEqual(["board.localhost", 8085]);
    expect(server).toMatchObject({ host: "127.0.0.1", port: 8085, strictPort: true, allowedHosts: ["board.localhost"], open: false });
  });

  it("takes ACTION_BOARD_HOST and ACTION_BOARD_PORT from the environment", async () => {
    vi.stubEnv("ACTION_BOARD_HOST", "Team.Localhost");
    vi.stubEnv("ACTION_BOARD_PORT", "5199");
    const cfg = await import("../vite.config");
    const { server } = cfg.default({ command: "serve", mode: "development" });
    expect([cfg.BOARD_HOST, cfg.BOARD_PORT]).toEqual(["team.localhost", 5199]);
    expect(server).toMatchObject({ port: 5199, allowedHosts: ["team.localhost"] });
  });

  it("opens the board's own URL only when start.sh sets AB_OPEN=1", async () => {
    vi.stubEnv("ACTION_BOARD_HOST", "");
    vi.stubEnv("ACTION_BOARD_PORT", "");
    vi.stubEnv("AB_OPEN", "1");
    const cfg = await import("../vite.config");
    const { server } = cfg.default({ command: "serve", mode: "development" });
    expect(server?.open).toBe("http://board.localhost:8085/");
  });
});
