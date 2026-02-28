import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "./types.js";

export type RunGhFn = (
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

async function defaultRunGh(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["gh", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function detectPrNumber(
  runGh: RunGhFn,
  cwd: string,
): Promise<number> {
  const result = await runGh(
    ["pr", "view", "--json", "number", "-q", ".number"],
    cwd,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      "No PR found for current branch. Specify prNumber explicitly.",
    );
  }
  return parseInt(result.stdout, 10);
}

async function getRepoInfo(
  runGh: RunGhFn,
  cwd: string,
): Promise<{ owner: string; repo: string }> {
  const result = await runGh(
    [
      "repo",
      "view",
      "--json",
      "owner,name",
      "-q",
      '.owner.login + "/" + .name',
    ],
    cwd,
  );
  if (result.exitCode !== 0) {
    throw new Error("Could not determine repository info");
  }
  const [owner, repo] = result.stdout.split("/");
  return { owner, repo };
}

function errorResult(error: string, details?: string) {
  const payload: Record<string, string> = { error };
  if (details) payload.details = details;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError: true,
  };
}

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

async function resolvePrNumber(
  prNumber: number | undefined,
  runGh: RunGhFn,
  cwd: string,
): Promise<number> {
  if (prNumber !== undefined) return prNumber;
  return detectPrNumber(runGh, cwd);
}

export function registerPrTools(
  server: McpServer,
  context: ToolContext,
  runGh: RunGhFn = defaultRunGh,
): void {
  const cwd = context.workspacePath;

  // --- get_pr_status ---
  server.tool(
    "get_pr_status",
    "Get structured PR status: title, state, mergeability, checks, review decision. Auto-detects PR for current branch if no number given.",
    {
      prNumber: z
        .number()
        .optional()
        .describe("PR number (auto-detects from current branch if omitted)"),
    },
    async ({ prNumber }) => {
      let num: number;
      try {
        num = await resolvePrNumber(prNumber, runGh, cwd);
      } catch (e) {
        return errorResult((e as Error).message);
      }

      const result = await runGh(
        [
          "pr",
          "view",
          String(num),
          "--json",
          "number,title,state,url,mergeable,isDraft,mergeStateStatus,headRefName,baseRefName,reviewDecision,statusCheckRollup",
        ],
        cwd,
      );

      if (result.exitCode !== 0) {
        return errorResult("Failed to get PR status", result.stderr);
      }

      let pr: Record<string, unknown>;
      try {
        pr = JSON.parse(result.stdout);
      } catch {
        return errorResult("Failed to parse PR data", result.stdout);
      }

      // Summarize checks status from statusCheckRollup
      const checks = pr.statusCheckRollup as
        | Array<{ state: string }>
        | null
        | undefined;
      let checksStatus = "unknown";
      if (checks && checks.length > 0) {
        const states = checks.map((c) => c.state?.toUpperCase());
        if (states.every((s) => s === "SUCCESS")) {
          checksStatus = "all_passing";
        } else if (states.some((s) => s === "FAILURE" || s === "ERROR")) {
          checksStatus = "some_failing";
        } else if (states.some((s) => s === "PENDING" || s === "EXPECTED")) {
          checksStatus = "pending";
        }
      } else {
        checksStatus = "none";
      }

      return jsonResult({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        url: pr.url,
        isDraft: pr.isDraft ?? false,
        mergeable: pr.mergeable,
        mergeableState: pr.mergeStateStatus ?? null,
        hasConflicts: pr.mergeable === "CONFLICTING",
        headRef: pr.headRefName,
        baseRef: pr.baseRefName,
        reviewDecision: pr.reviewDecision ?? null,
        checksStatus,
      });
    },
  );

  // --- list_pr_review_comments ---
  server.tool(
    "list_pr_review_comments",
    "List inline review comment threads on a PR, grouped by thread with resolved/unresolved status.",
    {
      prNumber: z
        .number()
        .optional()
        .describe("PR number (auto-detects from current branch if omitted)"),
      status: z
        .enum(["unresolved", "resolved", "all"])
        .optional()
        .default("all")
        .describe("Filter threads by resolution status"),
    },
    async ({ prNumber, status }) => {
      let num: number;
      try {
        num = await resolvePrNumber(prNumber, runGh, cwd);
      } catch (e) {
        return errorResult((e as Error).message);
      }

      let repoInfo: { owner: string; repo: string };
      try {
        repoInfo = await getRepoInfo(runGh, cwd);
      } catch (e) {
        return errorResult((e as Error).message);
      }

      const query = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 50) {
            nodes {
              id
              databaseId
              body
              author { login }
              path
              line
            }
          }
        }
      }
    }
  }
}`;

      const result = await runGh(
        ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${repoInfo.owner}`, "-f", `repo=${repoInfo.repo}`, "-F", `number=${num}`],
        cwd,
      );

      if (result.exitCode !== 0) {
        return errorResult("Failed to fetch review threads", result.stderr);
      }

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(result.stdout);
      } catch {
        return errorResult("Failed to parse GraphQL response", result.stdout);
      }

      const pr = (data as any).data?.repository?.pullRequest;
      if (!pr) {
        return errorResult("PR not found in GraphQL response");
      }

      const threads = (pr.reviewThreads?.nodes ?? []).map(
        (thread: any) => {
          const comments = thread.comments?.nodes ?? [];
          const first = comments[0];
          return {
            threadId: thread.id,
            isResolved: thread.isResolved,
            path: first?.path ?? null,
            line: first?.line ?? null,
            body: first?.body ?? "",
            author: first?.author?.login ?? null,
            firstCommentId: first?.databaseId ?? null,
            replies: comments.slice(1).map((c: any) => ({
              id: c.databaseId,
              body: c.body,
              author: c.author?.login ?? null,
            })),
          };
        },
      );

      // Filter by status
      let filtered = threads;
      if (status === "unresolved") {
        filtered = threads.filter((t: any) => !t.isResolved);
      } else if (status === "resolved") {
        filtered = threads.filter((t: any) => t.isResolved);
      }

      return jsonResult({ threads: filtered });
    },
  );

  // --- reply_to_pr_review_comment ---
  server.tool(
    "reply_to_pr_review_comment",
    "Reply to a PR review comment thread by comment ID.",
    {
      commentId: z.number().describe("The ID of the comment to reply to"),
      body: z.string().describe("Reply body text"),
    },
    async ({ commentId, body }) => {
      let repoInfo: { owner: string; repo: string };
      try {
        repoInfo = await getRepoInfo(runGh, cwd);
      } catch (e) {
        return errorResult((e as Error).message);
      }

      const result = await runGh(
        [
          "api",
          `/repos/${repoInfo.owner}/${repoInfo.repo}/pulls/comments/${commentId}/replies`,
          "-f",
          `body=${body}`,
        ],
        cwd,
      );

      if (result.exitCode !== 0) {
        return errorResult("Failed to reply to comment", result.stderr);
      }

      return jsonResult({ commentId, replied: true });
    },
  );

  // --- resolve_pr_review_thread ---
  server.tool(
    "resolve_pr_review_thread",
    "Resolve a PR review thread by its GraphQL thread ID.",
    {
      threadId: z.string().describe("The GraphQL thread ID to resolve"),
    },
    async ({ threadId }) => {
      const query = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

      const result = await runGh(
        ["api", "graphql", "-f", `query=${query}`, "-f", `threadId=${threadId}`],
        cwd,
      );

      if (result.exitCode !== 0) {
        return errorResult("Failed to resolve thread", result.stderr);
      }

      return jsonResult({ threadId, resolved: true });
    },
  );

  // --- list_pr_comments ---
  server.tool(
    "list_pr_comments",
    "List general (non-review) comments on a PR.",
    {
      prNumber: z
        .number()
        .optional()
        .describe("PR number (auto-detects from current branch if omitted)"),
    },
    async ({ prNumber }) => {
      let num: number;
      try {
        num = await resolvePrNumber(prNumber, runGh, cwd);
      } catch (e) {
        return errorResult((e as Error).message);
      }

      let repoInfo: { owner: string; repo: string };
      try {
        repoInfo = await getRepoInfo(runGh, cwd);
      } catch (e) {
        return errorResult((e as Error).message);
      }

      const result = await runGh(
        [
          "api",
          `/repos/${repoInfo.owner}/${repoInfo.repo}/issues/${num}/comments`,
        ],
        cwd,
      );

      if (result.exitCode !== 0) {
        return errorResult("Failed to list PR comments", result.stderr);
      }

      let comments: any[];
      try {
        comments = JSON.parse(result.stdout);
      } catch {
        return errorResult("Failed to parse comments", result.stdout);
      }

      return jsonResult({
        comments: comments.map((c: any) => ({
          id: c.id,
          author: c.user?.login ?? null,
          body: c.body,
          createdAt: c.created_at,
        })),
      });
    },
  );

  // --- post_pr_comment ---
  server.tool(
    "post_pr_comment",
    "Post a general comment on a PR.",
    {
      prNumber: z
        .number()
        .optional()
        .describe("PR number (auto-detects from current branch if omitted)"),
      body: z.string().describe("Comment body text"),
    },
    async ({ prNumber, body }) => {
      let num: number;
      try {
        num = await resolvePrNumber(prNumber, runGh, cwd);
      } catch (e) {
        return errorResult((e as Error).message);
      }

      const result = await runGh(
        ["pr", "comment", String(num), "--body", body],
        cwd,
      );

      if (result.exitCode !== 0) {
        return errorResult("Failed to post comment", result.stderr);
      }

      return jsonResult({ commented: true });
    },
  );

  // --- update_pr_branch ---
  server.tool(
    "update_pr_branch",
    "Update a PR branch from the base branch (merge upstream changes).",
    {
      prNumber: z
        .number()
        .optional()
        .describe("PR number (auto-detects from current branch if omitted)"),
    },
    async ({ prNumber }) => {
      let num: number;
      try {
        num = await resolvePrNumber(prNumber, runGh, cwd);
      } catch (e) {
        return errorResult((e as Error).message);
      }

      let repoInfo: { owner: string; repo: string };
      try {
        repoInfo = await getRepoInfo(runGh, cwd);
      } catch (e) {
        return errorResult((e as Error).message);
      }

      const result = await runGh(
        [
          "api",
          "-X",
          "PUT",
          `/repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${num}/update-branch`,
        ],
        cwd,
      );

      if (result.exitCode !== 0) {
        return errorResult("Failed to update PR branch", result.stderr);
      }

      return jsonResult({ updated: true });
    },
  );

  // --- github_api ---
  server.tool(
    "github_api",
    "Generic GitHub REST API proxy. Escape hatch for any GitHub operation not covered by specific tools.",
    {
      method: z
        .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
        .optional()
        .default("GET")
        .describe("HTTP method"),
      path: z.string().describe("GitHub API path (e.g. /repos/{owner}/{repo}/issues)"),
      body: z
        .string()
        .optional()
        .describe("JSON request body (for POST/PUT/PATCH)"),
    },
    async ({ method, path, body }) => {
      const args = ["api", "-X", method, path];

      if (body && method !== "GET" && method !== "DELETE") {
        args.push("--input", "-");
      }

      let result: { stdout: string; stderr: string; exitCode: number };

      if (body && method !== "GET" && method !== "DELETE") {
        // Pipe body via stdin
        const proc = Bun.spawn(["gh", ...args], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          stdin: new Blob([body]),
        });
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        result = { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
      } else {
        result = await runGh(args, cwd);
      }

      if (result.exitCode !== 0) {
        return errorResult("GitHub API request failed", result.stderr);
      }

      // Try to parse as JSON, return raw if not JSON
      try {
        const data = JSON.parse(result.stdout);
        return jsonResult(data);
      } catch {
        return jsonResult({ raw: result.stdout });
      }
    },
  );
}
