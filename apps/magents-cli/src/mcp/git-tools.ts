import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "./types.js";
import { runGit } from "./git-utils.js";

interface StatusEntry {
  path: string;
  status: string;
}

interface GitStatusResult {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: StatusEntry[];
  modified: StatusEntry[];
  untracked: string[];
}

const STATUS_CODES: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
};

function parseGitStatus(output: string): GitStatusResult {
  const result: GitStatusResult = {
    branch: "",
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    modified: [],
    untracked: [],
  };

  for (const line of output.split("\n")) {
    if (!line) continue;

    if (line.startsWith("# branch.head ")) {
      result.branch = line.slice("# branch.head ".length);
    } else if (line.startsWith("# branch.upstream ")) {
      result.upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+) -(\d+)/);
      if (match) {
        result.ahead = Number.parseInt(match[1], 10);
        result.behind = Number.parseInt(match[2], 10);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      // Ordinary (1) or rename/copy (2) changed entry
      // Format: 1 XY sub mH mI mW hH hI path
      // Format: 2 XY sub mH mI mW hH hI X### path\torigPath
      const parts = line.split(" ");
      const xy = parts[1];
      const x = xy[0]; // staged status
      const y = xy[1]; // unstaged status

      // For type "2" (rename), path contains a tab separator
      let path: string;
      if (line.startsWith("2 ")) {
        const restAfterFields = parts.slice(8).join(" ");
        path = restAfterFields.split("\t")[0];
      } else {
        path = parts.slice(8).join(" ");
      }

      if (x !== ".") {
        result.staged.push({ path, status: STATUS_CODES[x] || x });
      }
      if (y !== ".") {
        result.modified.push({ path, status: STATUS_CODES[y] || y });
      }
    } else if (line.startsWith("? ")) {
      result.untracked.push(line.slice(2));
    }
  }

  return result;
}

const DISALLOWED_STAGE_PATHS = new Set([".", "*", "-A", "--all"]);

export function registerGitTools(
  server: McpServer,
  context: ToolContext,
): void {
  // --- git_status ---
  server.tool(
    "git_status",
    "Get structured git status: branch, staged/modified/untracked files, ahead/behind counts",
    {},
    async () => {
      const { stdout, exitCode } = await runGit(
        ["status", "--porcelain=v2", "--branch"],
        context.workspacePath,
      );

      if (exitCode !== 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "git status failed",
                details: stdout,
              }),
            },
          ],
          isError: true,
        };
      }

      const status = parseGitStatus(stdout);
      return {
        content: [{ type: "text", text: JSON.stringify(status) }],
      };
    },
  );

  // --- git_stage ---
  server.tool(
    "git_stage",
    "Stage specific files for commit. Must specify individual file paths — refuses '.', '*', '-A', '--all'.",
    { paths: z.array(z.string()).min(1).describe("File paths to stage") },
    async ({ paths }) => {
      for (const p of paths) {
        if (DISALLOWED_STAGE_PATHS.has(p)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "Must specify individual file paths",
                  rejectedPath: p,
                }),
              },
            ],
            isError: true,
          };
        }
      }

      const { exitCode, stdout } = await runGit(
        ["add", ...paths],
        context.workspacePath,
      );

      if (exitCode !== 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "git add failed",
                details: stdout,
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ staged: paths }) }],
      };
    },
  );

  // --- agent_commit_changes ---
  server.tool(
    "agent_commit_changes",
    "Commit changes with a message. Optionally auto-stages specified files.",
    {
      message: z.string().min(1).describe("Commit message"),
      files: z
        .array(z.string())
        .optional()
        .describe("Files to stage before committing"),
    },
    async ({ message, files }) => {
      // Stage files if provided
      if (files && files.length > 0) {
        const { exitCode, stdout } = await runGit(
          ["add", ...files],
          context.workspacePath,
        );
        if (exitCode !== 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "git add failed",
                  details: stdout,
                }),
              },
            ],
            isError: true,
          };
        }
      }

      // Check if there's anything staged
      const { stdout: diffOutput } = await runGit(
        ["diff", "--cached", "--name-only"],
        context.workspacePath,
      );
      if (!diffOutput.trim()) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Nothing staged to commit",
              }),
            },
          ],
          isError: true,
        };
      }

      // Commit
      const { exitCode: commitExitCode, stdout: commitOutput } = await runGit(
        ["commit", "-m", message],
        context.workspacePath,
      );
      if (commitExitCode !== 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "git commit failed",
                details: commitOutput,
              }),
            },
          ],
          isError: true,
        };
      }

      // Get commit hash
      const { stdout: commitHash } = await runGit(
        ["log", "-1", "--format=%H", "HEAD"],
        context.workspacePath,
      );

      // Get files changed count
      const { stdout: filesChangedOutput } = await runGit(
        ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
        context.workspacePath,
      );
      const filesChanged = filesChangedOutput
        .split("\n")
        .filter(Boolean).length;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              commitHash: commitHash.trim(),
              message,
              filesChanged,
            }),
          },
        ],
      };
    },
  );

  // --- check_merge_conflicts ---
  server.tool(
    "check_merge_conflicts",
    "Check if merging current branch into a target branch would cause conflicts, without modifying the working tree.",
    {
      targetBranch: z
        .string()
        .optional()
        .describe(
          'Target branch to check merge against (defaults to "main" or "master")',
        ),
    },
    async ({ targetBranch }) => {
      let target = targetBranch;

      // Auto-detect default branch if not specified
      if (!target) {
        const { exitCode: mainCheck } = await runGit(
          ["rev-parse", "--verify", "main"],
          context.workspacePath,
        );
        if (mainCheck === 0) {
          target = "main";
        } else {
          const { exitCode: masterCheck } = await runGit(
            ["rev-parse", "--verify", "master"],
            context.workspacePath,
          );
          if (masterCheck === 0) {
            target = "master";
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error:
                      "Could not find main or master branch. Specify targetBranch explicitly.",
                  }),
                },
              ],
              isError: true,
            };
          }
        }
      }

      // Try merge-tree (git 2.38+)
      const { exitCode, stdout } = await runGit(
        ["merge-tree", "--write-tree", "HEAD", target],
        context.workspacePath,
      );

      if (exitCode === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                hasConflicts: false,
                targetBranch: target,
              }),
            },
          ],
        };
      }

      // Parse conflicted files from merge-tree output
      // Conflicted files appear after "CONFLICT" lines
      const conflictedFiles: string[] = [];
      for (const line of stdout.split("\n")) {
        const conflictMatch = line.match(
          /^CONFLICT \([^)]+\): Merge conflict in (.+)$/,
        );
        if (conflictMatch) {
          conflictedFiles.push(conflictMatch[1]);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              hasConflicts: true,
              targetBranch: target,
              conflictedFiles,
            }),
          },
        ],
      };
    },
  );
}
