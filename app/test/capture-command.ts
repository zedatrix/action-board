import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Capture both streams with files so shell commands, their redirects and nested Node processes
// all have a complete result before the assertions read it.
export function captureCommand(command: string, args: string[], options: Pick<SpawnSyncOptions, "cwd" | "env" | "timeout">) {
  const dir = mkdtempSync(join(tmpdir(), "ab-command-"));
  const stdout = join(dir, "stdout");
  const stderr = join(dir, "stderr");
  try {
    const outFd = openSync(stdout, "w");
    const errFd = openSync(stderr, "w");
    try {
      const result = spawnSync(command, args, { ...options, stdio: ["ignore", outFd, errFd] });
      if (result.error) throw result.error;
      return { status: result.status, stdout: readFileSync(stdout, "utf8"), stderr: readFileSync(stderr, "utf8") };
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
