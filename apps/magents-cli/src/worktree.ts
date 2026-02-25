import path from "node:path";

import { OrchestrationError, type WorktreeInfo, type WorktreeManager } from "./types";

export class GitWorktreeManager implements WorktreeManager {
  async provision(input: {
    sessionId: string;
    sourceRoot: string;
    requestedPath?: string;
    baseRef?: string;
  }): Promise<string> {
    const baseRef = input.baseRef ?? "main";
    const branchName = `magents/${input.sessionId}`;
    const targetPath =
      input.requestedPath ??
      path.join(input.sourceRoot, ".magents", input.sessionId);

    assertGitRepo(input.sourceRoot);

    const result = Bun.spawnSync(
      ["git", "worktree", "add", targetPath, "-b", branchName, baseRef],
      { cwd: input.sourceRoot, stdout: "pipe", stderr: "pipe" },
    );

    if (!result.success) {
      const stderr = result.stderr.toString().trim();

      if (stderr.includes("already exists")) {
        throw new OrchestrationError(
          "WORKTREE_BRANCH_EXISTS",
          `Branch '${branchName}' already exists. Cannot create worktree.`,
        );
      }

      if (stderr.includes("is a working tree")) {
        throw new OrchestrationError(
          "WORKTREE_PATH_EXISTS",
          `Path '${targetPath}' is already a git worktree.`,
        );
      }

      throw new OrchestrationError(
        "WORKTREE_CREATE_FAILED",
        `Failed to create worktree: ${stderr}`,
      );
    }

    return targetPath;
  }

  async cleanup(input: {
    sourceRoot: string;
    path: string;
    force?: boolean;
  }): Promise<void> {
    assertGitRepo(input.sourceRoot);

    const args = ["git", "worktree", "remove", input.path];
    if (input.force) args.push("--force");

    const result = Bun.spawnSync(args, {
      cwd: input.sourceRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (!result.success) {
      const stderr = result.stderr.toString().trim();

      // Worktree directory was already deleted manually — prune instead
      if (
        stderr.includes("No such file or directory") ||
        stderr.includes("is not a working tree")
      ) {
        const pruneResult = Bun.spawnSync(["git", "worktree", "prune"], {
          cwd: input.sourceRoot,
          stdout: "pipe",
          stderr: "pipe",
        });
        if (pruneResult.success) return;
        // If prune also fails, fall through to the generic error
      }

      if (stderr.includes("contains modified or untracked files")) {
        throw new OrchestrationError(
          "WORKTREE_DIRTY",
          `Worktree at '${input.path}' has uncommitted changes. Use force to remove anyway.`,
        );
      }

      throw new OrchestrationError(
        "WORKTREE_REMOVE_FAILED",
        `Failed to remove worktree: ${stderr}`,
      );
    }
  }

  async list(sourceRoot: string): Promise<WorktreeInfo[]> {
    assertGitRepo(sourceRoot);

    const result = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
      cwd: sourceRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (!result.success) {
      const stderr = result.stderr.toString().trim();
      throw new OrchestrationError(
        "WORKTREE_LIST_FAILED",
        `Failed to list worktrees: ${stderr}`,
      );
    }

    return parsePorcelainOutput(result.stdout.toString());
  }

  async exists(worktreePath: string): Promise<boolean> {
    const gitFile = Bun.file(path.join(worktreePath, ".git"));
    if (!(await gitFile.exists())) {
      return false;
    }

    try {
      const content = await gitFile.text();
      return content.trimStart().startsWith("gitdir:");
    } catch {
      return false;
    }
  }
}

/**
 * Parse `git worktree list --porcelain` output into structured data.
 *
 * Format per worktree (blocks separated by blank lines):
 *   worktree /path/to/worktree
 *   HEAD abc123...
 *   branch refs/heads/branch-name
 *   (or "detached" instead of branch line)
 *   (or "bare" for bare repos)
 */
export function parsePorcelainOutput(output: string): WorktreeInfo[] {
  const results: WorktreeInfo[] = [];

  // Split into blocks by blank lines
  const blocks = output.trim().split(/\n\n+/);

  for (const block of blocks) {
    if (!block.trim()) continue;

    const lines = block.trim().split("\n");

    let worktree = "";
    let HEAD = "";
    let branch = "";
    let bare = false;
    let detached = false;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        worktree = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        HEAD = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length);
      } else if (line === "bare") {
        bare = true;
      } else if (line === "detached") {
        detached = true;
      }
    }

    if (worktree) {
      results.push({ worktree, HEAD, branch, bare, detached });
    }
  }

  return results;
}

function assertGitRepo(dir: string): void {
  const result = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (!result.success) {
    throw new OrchestrationError(
      "NOT_A_GIT_REPO",
      `'${dir}' is not a git repository.`,
    );
  }
}
