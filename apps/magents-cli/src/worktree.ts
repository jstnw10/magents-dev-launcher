import { execSync } from "node:child_process";
import { readFile, access } from "node:fs/promises";
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

    try {
      execSync(
        `git worktree add ${quote(targetPath)} -b ${quote(branchName)} ${quote(baseRef)}`,
        { cwd: input.sourceRoot, stdio: "pipe" },
      );
    } catch (err) {
      const stderr = extractStderr(err);

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

    const forceFlag = input.force ? " --force" : "";

    try {
      execSync(`git worktree remove ${quote(input.path)}${forceFlag}`, {
        cwd: input.sourceRoot,
        stdio: "pipe",
      });
    } catch (err) {
      const stderr = extractStderr(err);

      // Worktree directory was already deleted manually — prune instead
      if (
        stderr.includes("No such file or directory") ||
        stderr.includes("is not a working tree")
      ) {
        try {
          execSync("git worktree prune", {
            cwd: input.sourceRoot,
            stdio: "pipe",
          });
          return;
        } catch {
          // If prune also fails, fall through to the generic error
        }
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

    let output: string;
    try {
      output = execSync("git worktree list --porcelain", {
        cwd: sourceRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const stderr = extractStderr(err);
      throw new OrchestrationError(
        "WORKTREE_LIST_FAILED",
        `Failed to list worktrees: ${stderr}`,
      );
    }

    return parsePorcelainOutput(output);
  }

  async exists(worktreePath: string): Promise<boolean> {
    try {
      await access(worktreePath);
    } catch {
      return false;
    }

    try {
      const gitFilePath = path.join(worktreePath, ".git");
      const content = await readFile(gitFilePath, "utf-8");
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
  try {
    execSync("git rev-parse --git-dir", { cwd: dir, stdio: "pipe" });
  } catch {
    throw new OrchestrationError(
      "NOT_A_GIT_REPO",
      `'${dir}' is not a git repository.`,
    );
  }
}

/** Shell-quote a string for use in a command. */
function quote(s: string): string {
  // Wrap in single-quotes and escape any embedded single-quotes
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function extractStderr(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "stderr" in err
  ) {
    const stderr = (err as { stderr: unknown }).stderr;
    if (Buffer.isBuffer(stderr)) return stderr.toString("utf-8").trim();
    if (typeof stderr === "string") return stderr.trim();
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
