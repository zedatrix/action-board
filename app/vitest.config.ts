import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.{ts,tsx}"], environment: "node", testTimeout: 30000, env: { ACTION_BOARD_PR_REPOS: "acme/example-api,acme/example-web", ACTION_BOARD_GITHUB_LOGIN: "alice" } },
});
