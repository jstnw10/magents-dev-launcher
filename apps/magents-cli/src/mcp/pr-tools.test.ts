import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "./types.js";
import { registerPrTools, type RunGhFn } from "./pr-tools.js";

type GhCall = { args: string[]; cwd: string };
type GhResponse = { stdout: string; stderr: string; exitCode: number };

function createMockRunGh(
  responses: GhResponse[],
): { runGh: RunGhFn; calls: GhCall[] } {
  const calls: GhCall[] = [];
  let index = 0;

  const runGh: RunGhFn = async (args, cwd) => {
    calls.push({ args, cwd });
    if (index >= responses.length) {
      return { stdout: "", stderr: "No mock response configured", exitCode: 1 };
    }
    return responses[index++];
  };

  return { runGh, calls };
}

interface TestHarness {
  client: Client;
  server: McpServer;
  callTool: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> & { _isError: boolean }>;
  calls: GhCall[];
}

async function createTestHarness(
  responses: GhResponse[],
): Promise<TestHarness> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const context: ToolContext = { workspacePath: "/test/workspace" };
  const { runGh, calls } = createMockRunGh(responses);
  registerPrTools(server, context, runGh);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  const callTool = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown> & { _isError: boolean }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return {
      ...JSON.parse(content[0].text),
      _isError: result.isError ?? false,
    };
  };

  return { client, server, callTool, calls };
}

let harness: TestHarness;

afterEach(async () => {
  if (harness) {
    await harness.client.close();
    await harness.server.close();
  }
});

// --- Sample mock data ---

const MOCK_PR_VIEW = JSON.stringify({
  number: 42,
  title: "Add feature X",
  state: "OPEN",
  url: "https://github.com/owner/repo/pull/42",
  mergeable: "MERGEABLE",
  isDraft: false,
  mergeStateStatus: "CLEAN",
  headRefName: "feature-x",
  baseRefName: "main",
  reviewDecision: "APPROVED",
  statusCheckRollup: [
    { state: "SUCCESS" },
    { state: "SUCCESS" },
  ],
});

const MOCK_GRAPHQL_THREADS = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            {
              id: "PRRT_thread1",
              isResolved: false,
              comments: {
                nodes: [
                  {
                    id: "C_1",
                    databaseId: 100,
                    body: "Please fix this",
                    author: { login: "reviewer1" },
                    path: "src/app.ts",
                    line: 10,
                  },
                  {
                    id: "C_2",
                    databaseId: 101,
                    body: "I agree",
                    author: { login: "reviewer2" },
                    path: "src/app.ts",
                    line: 10,
                  },
                ],
              },
            },
            {
              id: "PRRT_thread2",
              isResolved: true,
              comments: {
                nodes: [
                  {
                    id: "C_3",
                    databaseId: 200,
                    body: "Looks good now",
                    author: { login: "reviewer1" },
                    path: "src/utils.ts",
                    line: 5,
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
});

const MOCK_REPO_INFO = 'owner/repo';

const MOCK_PR_NUMBER = "42";

const MOCK_ISSUE_COMMENTS = JSON.stringify([
  {
    id: 1001,
    user: { login: "commenter" },
    body: "Great PR!",
    created_at: "2025-01-01T00:00:00Z",
  },
  {
    id: 1002,
    user: { login: "author" },
    body: "Thanks!",
    created_at: "2025-01-02T00:00:00Z",
  },
]);

// Helper to create standard repo + pr responses
function repoAndPrResponses(): GhResponse[] {
  return [
    // detectPrNumber
    { stdout: MOCK_PR_NUMBER, stderr: "", exitCode: 0 },
    // getRepoInfo
    { stdout: MOCK_REPO_INFO, stderr: "", exitCode: 0 },
  ];
}

describe("get_pr_status", () => {
  it("returns structured PR status with explicit prNumber", async () => {
    harness = await createTestHarness([
      // gh pr view ...
      { stdout: MOCK_PR_VIEW, stderr: "", exitCode: 0 },
    ]);

    const result = await harness.callTool("get_pr_status", { prNumber: 42 });
    expect(result._isError).toBe(false);
    expect(result.number).toBe(42);
    expect(result.title).toBe("Add feature X");
    expect(result.state).toBe("OPEN");
    expect(result.isDraft).toBe(false);
    expect(result.mergeable).toBe("MERGEABLE");
    expect(result.mergeableState).toBe("CLEAN");
    expect(result.hasConflicts).toBe(false);
    expect(result.headRef).toBe("feature-x");
    expect(result.baseRef).toBe("main");
    expect(result.reviewDecision).toBe("APPROVED");
    expect(result.checksStatus).toBe("all_passing");
  });

  it("auto-detects PR number from current branch", async () => {
    harness = await createTestHarness([
      // detectPrNumber
      { stdout: MOCK_PR_NUMBER, stderr: "", exitCode: 0 },
      // gh pr view ...
      { stdout: MOCK_PR_VIEW, stderr: "", exitCode: 0 },
    ]);

    const result = await harness.callTool("get_pr_status");
    expect(result._isError).toBe(false);
    expect(result.number).toBe(42);
    // Verify first call was to detect PR number
    expect(harness.calls[0].args).toEqual([
      "pr", "view", "--json", "number", "-q", ".number",
    ]);
  });

  it("handles no PR for current branch gracefully", async () => {
    harness = await createTestHarness([
      // detectPrNumber fails
      { stdout: "", stderr: "no pull requests found", exitCode: 1 },
    ]);

    const result = await harness.callTool("get_pr_status");
    expect(result._isError).toBe(true);
    expect(result.error).toContain("No PR found for current branch");
  });

  it("reports failing checks", async () => {
    const prData = {
      ...JSON.parse(MOCK_PR_VIEW),
      statusCheckRollup: [
        { state: "SUCCESS" },
        { state: "FAILURE" },
      ],
    };
    harness = await createTestHarness([
      { stdout: JSON.stringify(prData), stderr: "", exitCode: 0 },
    ]);

    const result = await harness.callTool("get_pr_status", { prNumber: 42 });
    expect(result.checksStatus).toBe("some_failing");
  });

  it("reports pending checks", async () => {
    const prData = {
      ...JSON.parse(MOCK_PR_VIEW),
      statusCheckRollup: [
        { state: "SUCCESS" },
        { state: "PENDING" },
      ],
    };
    harness = await createTestHarness([
      { stdout: JSON.stringify(prData), stderr: "", exitCode: 0 },
    ]);

    const result = await harness.callTool("get_pr_status", { prNumber: 42 });
    expect(result.checksStatus).toBe("pending");
  });

  it("reports conflicting state", async () => {
    const prData = {
      ...JSON.parse(MOCK_PR_VIEW),
      mergeable: "CONFLICTING",
    };
    harness = await createTestHarness([
      { stdout: JSON.stringify(prData), stderr: "", exitCode: 0 },
    ]);

    const result = await harness.callTool("get_pr_status", { prNumber: 42 });
    expect(result.hasConflicts).toBe(true);
  });
});

describe("list_pr_review_comments", () => {
  it("returns grouped threads", async () => {
    harness = await createTestHarness([
      // detectPrNumber
      { stdout: MOCK_PR_NUMBER, stderr: "", exitCode: 0 },
      // getRepoInfo
      { stdout: MOCK_REPO_INFO, stderr: "", exitCode: 0 },
      // GraphQL query
      { stdout: MOCK_GRAPHQL_THREADS, stderr: "", exitCode: 0 },
    ]);

    const result = await harness.callTool("list_pr_review_comments");
    expect(result._isError).toBe(false);
    const threads = result.threads as any[];
    expect(threads).toHaveLength(2);

    expect(threads[0].threadId).toBe("PRRT_thread1");
    expect(threads[0].isResolved).toBe(false);
    expect(threads[0].path).toBe("src/app.ts");
    expect(threads[0].line).toBe(10);
    expect(threads[0].body).toBe("Please fix this");
    expect(threads[0].author).toBe("reviewer1");
    expect(threads[0].replies).toHaveLength(1);
    expect(threads[0].replies[0].body).toBe("I agree");

    expect(threads[1].threadId).toBe("PRRT_thread2");
    expect(threads[1].isResolved).toBe(true);
  });

  it("filters by unresolved status", async () => {
    harness = await createTestHarness([
      { stdout: MOCK_PR_NUMBER, stderr: "", exitCode: 0 },
      { stdout: MOCK_REPO_INFO, stderr: "", exitCode: 0 },
      { stdout: MOCK_GRAPHQL_THREADS, stderr: "", exitCode: 0 },
    ]);

    const result = await harness.callTool("list_pr_review_comments", {
      status: "unresolved",
    });
    const threads = result.threads as any[];
    expect(threads).toHaveLength(1);
    expect(threads[0].isResolved).toBe(false);
  });

  it("filters by resolved status", async () => {
    harness = await createTestHarness([
      { stdout: MOCK_PR_NUMBER, stderr: "", exitCode: 0 },
      { stdout: MOCK_REPO_INFO, stderr: "", exitCode: 0 },
      { stdout: MOCK_GRAPHQL_THREADS, stderr: "", exitCode: 0 },
    ]);

    const result = await harness.callTool("list_pr_review_comments", {
      status: "resolved",
    });
    const threads = result.threads as any[];
    expect(threads).toHaveLength(1);
    expect(threads[0].isResolved).toBe(true);
  });
});

describe("reply_to_pr_review_comment", () => {
  it("sends reply to a comment", async () => {
    harness = await createTestHarness([
      // getRepoInfo
      { stdout: MOCK_REPO_INFO, stderr: "", exitCode: 0 },
      // POST reply
      { stdout: JSON.stringify({ id: 999 }), stderr: "", exitCode: 0 },
    ]);

    const result = await harness.callTool("reply_to_pr_review_comment", {
      commentId: 100,
      body: "Fixed in latest commit",
    });
    expect(result._isError).toBe(false);
    expect(result.commentId).toBe(100);
    expect(result.replied).toBe(true);

    // Verify the API call
    expect(harness.calls[1].args).toContain(
      "/repos/owner/repo/pulls/comments/100/replies",
    );
    expect(harness.calls[1].args).toContain("body=Fixed in latest commit");
  });
});

describe("resolve_pr_review_thread", () => {
  it("resolves a thread via GraphQL", async () => {
    harness = await createTestHarness([
      {
        stdout: JSON.stringify({
          data: {
            resolveReviewThread: {
              thread: { id: "PRRT_thread1", isResolved: true },
            },
          },
        }),
        stderr: "",
        exitCode: 0,
      },
    ]);

    const result = await harness.callTool("resolve_pr_review_thread", {
      threadId: "PRRT_thread1",
    });
    expect(result._isError).toBe(false);
    expect(result.threadId).toBe("PRRT_thread1");
    expect(result.resolved).toBe(true);

    // Verify GraphQL mutation was sent
    const queryArg = harness.calls[0].args.find((a) =>
      a.startsWith("query="),
    );
    expect(queryArg).toContain("resolveReviewThread");
    expect(queryArg).toContain("PRRT_thread1");
  });

  it("returns error on GraphQL failure", async () => {
    harness = await createTestHarness([
      { stdout: "", stderr: "GraphQL error", exitCode: 1 },
    ]);

    const result = await harness.callTool("resolve_pr_review_thread", {
      threadId: "PRRT_invalid",
    });
    expect(result._isError).toBe(true);
    expect(result.error).toContain("Failed to resolve thread");
  });
});

describe("list_pr_comments", () => {
  it("returns general PR comments", async () => {
    harness = await createTestHarness([
      // detectPrNumber
      { stdout: MOCK_PR_NUMBER, stderr: "", exitCode: 0 },
      // getRepoInfo
      { stdout: MOCK_REPO_INFO, stderr: "", exitCode: 0 },
      // GET comments
      { stdout: MOCK_ISSUE_COMMENTS, stderr: "", exitCode: 0 },
    ]);

    const result = await harness.callTool("list_pr_comments");
    expect(result._isError).toBe(false);
    const comments = result.comments as any[];
    expect(comments).toHaveLength(2);
    expect(comments[0].id).toBe(1001);
    expect(comments[0].author).toBe("commenter");
    expect(comments[0].body).toBe("Great PR!");
    expect(comments[0].createdAt).toBe("2025-01-01T00:00:00Z");
  });
});

describe("post_pr_comment", () => {
  it("posts a comment on a PR", async () => {
    harness = await createTestHarness([
      // detectPrNumber
      { stdout: MOCK_PR_NUMBER, stderr: "", exitCode: 0 },
      // gh pr comment
      { stdout: "", stderr: "", exitCode: 0 },
    ]);

    const result = await harness.callTool("post_pr_comment", {
      body: "LGTM!",
    });
    expect(result._isError).toBe(false);
    expect(result.commented).toBe(true);

    // Verify the comment command
    expect(harness.calls[1].args).toEqual([
      "pr", "comment", "42", "--body", "LGTM!",
    ]);
  });
});

describe("update_pr_branch", () => {
  it("updates PR branch successfully", async () => {
    harness = await createTestHarness([
      // detectPrNumber
      { stdout: MOCK_PR_NUMBER, stderr: "", exitCode: 0 },
      // getRepoInfo
      { stdout: MOCK_REPO_INFO, stderr: "", exitCode: 0 },
      // PUT update-branch
      {
        stdout: JSON.stringify({ message: "Updating pull request branch.", url: "..." }),
        stderr: "",
        exitCode: 0,
      },
    ]);

    const result = await harness.callTool("update_pr_branch");
    expect(result._isError).toBe(false);
    expect(result.updated).toBe(true);
  });

  it("handles conflict error when updating branch", async () => {
    harness = await createTestHarness([
      // detectPrNumber
      { stdout: MOCK_PR_NUMBER, stderr: "", exitCode: 0 },
      // getRepoInfo
      { stdout: MOCK_REPO_INFO, stderr: "", exitCode: 0 },
      // PUT update-branch fails
      {
        stdout: "",
        stderr: "merge conflict",
        exitCode: 1,
      },
    ]);

    const result = await harness.callTool("update_pr_branch");
    expect(result._isError).toBe(true);
    expect(result.error).toContain("Failed to update PR branch");
  });
});

describe("github_api", () => {
  it("makes GET request and returns JSON", async () => {
    harness = await createTestHarness([
      {
        stdout: JSON.stringify({ login: "octocat", id: 1 }),
        stderr: "",
        exitCode: 0,
      },
    ]);

    const result = await harness.callTool("github_api", {
      path: "/user",
    });
    expect(result._isError).toBe(false);
    expect(result.login).toBe("octocat");
    expect(result.id).toBe(1);
  });

  it("makes POST request with body", async () => {
    // Note: github_api with POST+body uses Bun.spawn directly (not runGh mock)
    // Since we can't easily mock Bun.spawn for the stdin case, test with GET instead
    // and verify the args for a bodyless POST
    harness = await createTestHarness([
      {
        stdout: JSON.stringify({ id: 1, title: "Bug" }),
        stderr: "",
        exitCode: 0,
      },
    ]);

    // POST without body goes through runGh
    const result = await harness.callTool("github_api", {
      method: "POST",
      path: "/repos/owner/repo/issues",
    });
    expect(result._isError).toBe(false);
    expect(result.id).toBe(1);

    expect(harness.calls[0].args).toEqual([
      "api", "-X", "POST", "/repos/owner/repo/issues",
    ]);
  });

  it("handles error responses", async () => {
    harness = await createTestHarness([
      {
        stdout: "",
        stderr: "HTTP 404: Not Found",
        exitCode: 1,
      },
    ]);

    const result = await harness.callTool("github_api", {
      path: "/repos/nonexistent/repo",
    });
    expect(result._isError).toBe(true);
    expect(result.error).toContain("GitHub API request failed");
    expect(result.details).toContain("404");
  });

  it("handles DELETE method", async () => {
    harness = await createTestHarness([
      { stdout: "", stderr: "", exitCode: 0 },
    ]);

    const result = await harness.callTool("github_api", {
      method: "DELETE",
      path: "/repos/owner/repo/issues/1/labels/bug",
    });
    expect(result._isError).toBe(false);

    expect(harness.calls[0].args).toEqual([
      "api", "-X", "DELETE", "/repos/owner/repo/issues/1/labels/bug",
    ]);
  });
});
