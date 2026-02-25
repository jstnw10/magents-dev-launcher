import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { GitWorktreeManager, parsePorcelainOutput } from "./worktree";

// Helper to create a successful spawnSync result
function okResult(stdout = ""): any {
  return {
    success: true,
    exitCode: 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(""),
  };
}

// Helper to create a failed spawnSync result
function failResult(stderr = ""): any {
  return {
    success: false,
    exitCode: 1,
    stdout: Buffer.from(""),
    stderr: Buffer.from(stderr),
  };
}

// Helper: check if an args array contains a substring in any element
function argsContain(args: string[], needle: string): boolean {
  return args.some((a) => a.includes(needle));
}

describe("GitWorktreeManager", () => {
  let manager: GitWorktreeManager;
  let mockSpawnSync: ReturnType<typeof mock>;
  const originalSpawnSync = Bun.spawnSync;

  beforeEach(() => {
    manager = new GitWorktreeManager();
    mockSpawnSync = mock((args: string[], _opts?: any) => {
      // Default: git rev-parse succeeds (valid git repo)
      if (argsContain(args, "rev-parse")) {
        return okResult(".git\n");
      }
      return okResult();
    });
    Bun.spawnSync = mockSpawnSync as any;
  });

  afterEach(() => {
    Bun.spawnSync = originalSpawnSync;
  });

  describe("provision", () => {
    it("runs git worktree add with correct arguments", async () => {
      const result = await manager.provision({
        sessionId: "sess-abc",
        sourceRoot: "/repo",
      });

      expect(result).toBe("/repo/.magents/sess-abc");

      // Find the worktree add call
      const addCall = mockSpawnSync.mock.calls.find(
        (c: any[]) => Array.isArray(c[0]) && c[0].includes("worktree") && c[0].includes("add"),
      );
      expect(addCall).toBeTruthy();
      expect(addCall![0]).toContain("magents/sess-abc");
      expect(addCall![0]).toContain("main");
      expect(addCall![1]).toEqual(expect.objectContaining({ cwd: "/repo" }));
    });

    it("uses requestedPath when provided", async () => {
      const result = await manager.provision({
        sessionId: "sess-custom",
        sourceRoot: "/repo",
        requestedPath: "/custom/path",
      });

      expect(result).toBe("/custom/path");
    });

    it("uses custom baseRef when provided", async () => {
      await manager.provision({
        sessionId: "sess-dev",
        sourceRoot: "/repo",
        baseRef: "develop",
      });

      const addCall = mockSpawnSync.mock.calls.find(
        (c: any[]) => Array.isArray(c[0]) && c[0].includes("worktree") && c[0].includes("add"),
      );
      expect(addCall![0]).toContain("develop");
    });

    it("throws WORKTREE_BRANCH_EXISTS when branch exists", async () => {
      mockSpawnSync.mockImplementation((args: string[], _opts?: any) => {
        if (argsContain(args, "rev-parse")) return okResult(".git\n");
        if (argsContain(args, "worktree") && argsContain(args, "add")) {
          return failResult("fatal: a branch named 'magents/sess-dup' already exists");
        }
        return okResult();
      });

      await expect(
        manager.provision({ sessionId: "sess-dup", sourceRoot: "/repo" }),
      ).rejects.toThrow("already exists");
    });

    it("throws WORKTREE_PATH_EXISTS when path is already a worktree", async () => {
      mockSpawnSync.mockImplementation((args: string[], _opts?: any) => {
        if (argsContain(args, "rev-parse")) return okResult(".git\n");
        if (argsContain(args, "worktree") && argsContain(args, "add")) {
          return failResult("fatal: '/repo/.magents/sess-x' is a working tree");
        }
        return okResult();
      });

      await expect(
        manager.provision({ sessionId: "sess-x", sourceRoot: "/repo" }),
      ).rejects.toThrow("already a git worktree");
    });

    it("throws NOT_A_GIT_REPO when sourceRoot is not a git repo", async () => {
      mockSpawnSync.mockImplementation((args: string[], _opts?: any) => {
        if (argsContain(args, "rev-parse")) {
          return failResult("fatal: not a git repository");
        }
        return okResult();
      });

      await expect(
        manager.provision({ sessionId: "sess-bad", sourceRoot: "/not-a-repo" }),
      ).rejects.toThrow("not a git repository");
    });
  });

  describe("cleanup", () => {
    it("runs git worktree remove", async () => {
      await manager.cleanup({
        sourceRoot: "/repo",
        path: "/repo/.magents/sess-rm",
      });

      const rmCall = mockSpawnSync.mock.calls.find(
        (c: any[]) => Array.isArray(c[0]) && c[0].includes("worktree") && c[0].includes("remove"),
      );
      expect(rmCall).toBeTruthy();
      expect(rmCall![0]).toContain("/repo/.magents/sess-rm");
    });

    it("passes --force flag when force is true", async () => {
      await manager.cleanup({
        sourceRoot: "/repo",
        path: "/repo/.magents/sess-force",
        force: true,
      });

      const rmCall = mockSpawnSync.mock.calls.find(
        (c: any[]) => Array.isArray(c[0]) && c[0].includes("worktree") && c[0].includes("remove"),
      );
      expect(rmCall![0]).toContain("--force");
    });

    it("prunes when worktree was already deleted manually", async () => {
      mockSpawnSync.mockImplementation((args: string[], _opts?: any) => {
        if (argsContain(args, "rev-parse")) return okResult(".git\n");
        if (argsContain(args, "worktree") && argsContain(args, "remove")) {
          return failResult("fatal: No such file or directory");
        }
        if (argsContain(args, "worktree") && argsContain(args, "prune")) {
          return okResult();
        }
        return okResult();
      });

      // Should not throw — gracefully prunes
      await manager.cleanup({
        sourceRoot: "/repo",
        path: "/repo/.magents/sess-gone",
      });

      const pruneCall = mockSpawnSync.mock.calls.find(
        (c: any[]) => Array.isArray(c[0]) && c[0].includes("worktree") && c[0].includes("prune"),
      );
      expect(pruneCall).toBeTruthy();
    });

    it("throws WORKTREE_DIRTY when worktree has uncommitted changes", async () => {
      mockSpawnSync.mockImplementation((args: string[], _opts?: any) => {
        if (argsContain(args, "rev-parse")) return okResult(".git\n");
        if (argsContain(args, "worktree") && argsContain(args, "remove")) {
          return failResult(
            "fatal: '/repo/.magents/sess-dirty' contains modified or untracked files, use --force to delete",
          );
        }
        return okResult();
      });

      await expect(
        manager.cleanup({
          sourceRoot: "/repo",
          path: "/repo/.magents/sess-dirty",
        }),
      ).rejects.toThrow("uncommitted changes");
    });
  });

  describe("list", () => {
    it("parses porcelain output correctly", async () => {
      const porcelain = [
        "worktree /repo",
        "HEAD abc1234567890",
        "branch refs/heads/main",
        "",
        "worktree /repo/.magents/sess-1",
        "HEAD def4567890123",
        "branch refs/heads/magents/sess-1",
        "",
      ].join("\n");

      mockSpawnSync.mockImplementation((args: string[], _opts?: any) => {
        if (argsContain(args, "rev-parse")) return okResult(".git\n");
        if (argsContain(args, "worktree") && argsContain(args, "list")) {
          return okResult(porcelain);
        }
        return okResult();
      });

      const result = await manager.list("/repo");

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        worktree: "/repo",
        HEAD: "abc1234567890",
        branch: "refs/heads/main",
        bare: false,
        detached: false,
      });
      expect(result[1]).toEqual({
        worktree: "/repo/.magents/sess-1",
        HEAD: "def4567890123",
        branch: "refs/heads/magents/sess-1",
        bare: false,
        detached: false,
      });
    });

    it("handles bare and detached worktrees", async () => {
      const porcelain = [
        "worktree /bare-repo",
        "HEAD 0000000000000",
        "bare",
        "",
        "worktree /detached-wt",
        "HEAD aaa1111222233",
        "detached",
        "",
      ].join("\n");

      mockSpawnSync.mockImplementation((args: string[], _opts?: any) => {
        if (argsContain(args, "rev-parse")) return okResult(".git\n");
        if (argsContain(args, "worktree") && argsContain(args, "list")) {
          return okResult(porcelain);
        }
        return okResult();
      });

      const result = await manager.list("/bare-repo");

      expect(result[0]!.bare).toBe(true);
      expect(result[0]!.detached).toBe(false);
      expect(result[1]!.bare).toBe(false);
      expect(result[1]!.detached).toBe(true);
    });
  });

  describe("exists", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(Bun.env.TMPDIR ?? "/tmp", "worktree-test-"));
    });

    it("returns true for a valid worktree (has .git file with gitdir:)", async () => {
      const worktreePath = path.join(tmpDir, "wt");
      await mkdir(worktreePath, { recursive: true });
      await writeFile(
        path.join(worktreePath, ".git"),
        "gitdir: /repo/.git/worktrees/sess-1\n",
      );

      const result = await manager.exists(worktreePath);
      expect(result).toBe(true);
    });

    it("returns false when directory does not exist", async () => {
      const result = await manager.exists(path.join(tmpDir, "nonexistent"));
      expect(result).toBe(false);
    });

    it("returns false when .git file does not start with gitdir:", async () => {
      const worktreePath = path.join(tmpDir, "bad-wt");
      await mkdir(worktreePath, { recursive: true });
      await writeFile(
        path.join(worktreePath, ".git"),
        "not a gitdir reference\n",
      );

      const result = await manager.exists(worktreePath);
      expect(result).toBe(false);
    });

    it("returns false when .git file does not exist", async () => {
      const worktreePath = path.join(tmpDir, "no-git");
      await mkdir(worktreePath, { recursive: true });

      const result = await manager.exists(worktreePath);
      expect(result).toBe(false);
    });
  });
});

describe("parsePorcelainOutput", () => {
  it("handles empty output", () => {
    expect(parsePorcelainOutput("")).toEqual([]);
  });

  it("handles single worktree", () => {
    const output = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n";
    const result = parsePorcelainOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0]!.worktree).toBe("/repo");
  });
});
