import { describe, expect, it, mock, beforeEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let mockExecSync: ReturnType<typeof mock>;

mock.module("node:child_process", () => {
  mockExecSync = mock();
  return { execSync: mockExecSync };
});

// Import AFTER mocking
const { GitWorktreeManager, parsePorcelainOutput } = await import("./worktree");

describe("GitWorktreeManager", () => {
  let manager: InstanceType<typeof GitWorktreeManager>;

  beforeEach(() => {
    manager = new GitWorktreeManager();
    mockExecSync.mockReset();
    // Default: git rev-parse succeeds (valid git repo)
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("rev-parse")) {
        return Buffer.from(".git\n");
      }
      return Buffer.from("");
    });
  });

  describe("provision", () => {
    it("runs git worktree add with correct arguments", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("rev-parse")) return Buffer.from(".git\n");
        if (cmd.includes("worktree add")) return Buffer.from("");
        return Buffer.from("");
      });

      const result = await manager.provision({
        sessionId: "sess-abc",
        sourceRoot: "/repo",
      });

      expect(result).toBe("/repo/.magents/sess-abc");
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("worktree add"),
        expect.objectContaining({ cwd: "/repo", stdio: "pipe" }),
      );
      // Should include the branch name and base ref
      const addCall = mockExecSync.mock.calls.find(
        (c: string[]) => typeof c[0] === "string" && c[0].includes("worktree add"),
      );
      expect(addCall![0]).toContain("magents/sess-abc");
      expect(addCall![0]).toContain("main");
    });

    it("uses requestedPath when provided", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("rev-parse")) return Buffer.from(".git\n");
        if (cmd.includes("worktree add")) return Buffer.from("");
        return Buffer.from("");
      });

      const result = await manager.provision({
        sessionId: "sess-custom",
        sourceRoot: "/repo",
        requestedPath: "/custom/path",
      });

      expect(result).toBe("/custom/path");
    });

    it("uses custom baseRef when provided", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("rev-parse")) return Buffer.from(".git\n");
        if (cmd.includes("worktree add")) return Buffer.from("");
        return Buffer.from("");
      });

      await manager.provision({
        sessionId: "sess-dev",
        sourceRoot: "/repo",
        baseRef: "develop",
      });

      const addCall = mockExecSync.mock.calls.find(
        (c: string[]) => typeof c[0] === "string" && c[0].includes("worktree add"),
      );
      expect(addCall![0]).toContain("develop");
    });

    it("throws WORKTREE_BRANCH_EXISTS when branch exists", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("rev-parse")) return Buffer.from(".git\n");
        if (cmd.includes("worktree add")) {
          const err = new Error("git error") as Error & { stderr: Buffer };
          err.stderr = Buffer.from("fatal: a branch named 'magents/sess-dup' already exists");
          throw err;
        }
        return Buffer.from("");
      });

      await expect(
        manager.provision({ sessionId: "sess-dup", sourceRoot: "/repo" }),
      ).rejects.toThrow("already exists");
    });

    it("throws WORKTREE_PATH_EXISTS when path is already a worktree", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("rev-parse")) return Buffer.from(".git\n");
        if (cmd.includes("worktree add")) {
          const err = new Error("git error") as Error & { stderr: Buffer };
          err.stderr = Buffer.from("fatal: '/repo/.magents/sess-x' is a working tree");
          throw err;
        }
        return Buffer.from("");
      });

      await expect(
        manager.provision({ sessionId: "sess-x", sourceRoot: "/repo" }),
      ).rejects.toThrow("already a git worktree");
    });

    it("throws NOT_A_GIT_REPO when sourceRoot is not a git repo", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("rev-parse")) {
          throw new Error("not a git repository");
        }
        return Buffer.from("");
      });

      await expect(
        manager.provision({ sessionId: "sess-bad", sourceRoot: "/not-a-repo" }),
      ).rejects.toThrow("not a git repository");
    });
  });

  describe("cleanup", () => {
    it("runs git worktree remove", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("rev-parse")) return Buffer.from(".git\n");
        if (cmd.includes("worktree remove")) return Buffer.from("");
        return Buffer.from("");
      });

      await manager.cleanup({
        sourceRoot: "/repo",
        path: "/repo/.magents/sess-rm",
      });

      const rmCall = mockExecSync.mock.calls.find(
        (c: string[]) => typeof c[0] === "string" && c[0].includes("worktree remove"),
      );
      expect(rmCall).toBeTruthy();
      expect(rmCall![0]).toContain("/repo/.magents/sess-rm");
    });

    it("passes --force flag when force is true", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("rev-parse")) return Buffer.from(".git\n");
        if (cmd.includes("worktree remove")) return Buffer.from("");
        return Buffer.from("");
      });

      await manager.cleanup({
        sourceRoot: "/repo",
        path: "/repo/.magents/sess-force",
        force: true,
      });

      const rmCall = mockExecSync.mock.calls.find(
        (c: string[]) => typeof c[0] === "string" && c[0].includes("worktree remove"),
      );
      expect(rmCall![0]).toContain("--force");
    });

    it("prunes when worktree was already deleted manually", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("rev-parse")) return Buffer.from(".git\n");
        if (cmd.includes("worktree remove")) {
          const err = new Error("git error") as Error & { stderr: Buffer };
          err.stderr = Buffer.from("fatal: No such file or directory");
          throw err;
        }
        if (cmd.includes("worktree prune")) return Buffer.from("");
        return Buffer.from("");
      });

      // Should not throw — gracefully prunes
      await manager.cleanup({
        sourceRoot: "/repo",
        path: "/repo/.magents/sess-gone",
      });

      const pruneCall = mockExecSync.mock.calls.find(
        (c: string[]) => typeof c[0] === "string" && c[0].includes("worktree prune"),
      );
      expect(pruneCall).toBeTruthy();
    });

    it("throws WORKTREE_DIRTY when worktree has uncommitted changes", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("rev-parse")) return Buffer.from(".git\n");
        if (cmd.includes("worktree remove")) {
          const err = new Error("git error") as Error & { stderr: Buffer };
          err.stderr = Buffer.from(
            "fatal: '/repo/.magents/sess-dirty' contains modified or untracked files, use --force to delete",
          );
          throw err;
        }
        return Buffer.from("");
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

      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("rev-parse")) return Buffer.from(".git\n");
        if (cmd.includes("worktree list")) return porcelain;
        return Buffer.from("");
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

      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("rev-parse")) return Buffer.from(".git\n");
        if (cmd.includes("worktree list")) return porcelain;
        return Buffer.from("");
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
      tmpDir = await mkdtemp(path.join(tmpdir(), "worktree-test-"));
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
