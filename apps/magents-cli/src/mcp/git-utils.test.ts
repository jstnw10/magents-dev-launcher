import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGit } from "./git-utils.js";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "git-utils-test-"));
  const proc = Bun.spawn(["git", "init", "-b", "main"], {
    cwd: testDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("runGit", () => {
  it("returns stdout and exitCode 0 for valid commands", async () => {
    const result = await runGit(["rev-parse", "--git-dir"], testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(".git");
  });

  it("throws for invalid cwd", async () => {
    expect(runGit(["status"], "/nonexistent-path-xyz")).rejects.toThrow();
  });

  it("returns trimmed output from git log", async () => {
    // Create a commit so git log has something to show
    await Bun.write(join(testDir, "file.txt"), "hello\n");
    const addProc = Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "pipe", stderr: "pipe" });
    await addProc.exited;
    const commitProc = Bun.spawn(
      ["git", "commit", "-m", "initial"],
      {
        cwd: testDir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@test.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@test.com",
        },
      },
    );
    await commitProc.exited;

    const result = await runGit(["log", "--oneline", "-1"], testDir);
    expect(result.exitCode).toBe(0);
    expect(typeof result.stdout).toBe("string");
    expect(result.stdout.length).toBeGreaterThan(0);
    // Should not have trailing whitespace
    expect(result.stdout).toBe(result.stdout.trimEnd());
  });
});
