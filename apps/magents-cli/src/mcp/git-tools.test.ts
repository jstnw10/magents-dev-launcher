import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "./types.js";
import { registerGitTools } from "./git-tools.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    },
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`);
  }
  return stdout.trimEnd();
}

async function createTestRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "git-tools-test-"));
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "test@test.com");
  await git(dir, "config", "user.name", "Test");
  await Bun.write(join(dir, "README.md"), "# Test Repo\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-m", "initial commit");
  return dir;
}

interface TestHarness {
  client: Client;
  server: McpServer;
  callTool: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

async function createTestHarness(workspacePath: string): Promise<TestHarness> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const context: ToolContext = { workspacePath };
  registerGitTools(server, context);

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
  ): Promise<Record<string, unknown>> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return {
      ...JSON.parse(content[0].text),
      _isError: result.isError ?? false,
    };
  };

  return { client, server, callTool };
}

let repoDir: string;
let harness: TestHarness;

beforeEach(async () => {
  repoDir = await createTestRepo();
  harness = await createTestHarness(repoDir);
});

afterEach(async () => {
  await harness.client.close();
  await harness.server.close();
  await rm(repoDir, { recursive: true, force: true });
});

describe("git_status", () => {
  it("returns correct branch and clean status", async () => {
    const result = await harness.callTool("git_status");
    expect(result.branch).toBe("main");
    expect(result.staged).toEqual([]);
    expect(result.modified).toEqual([]);
    expect(result.untracked).toEqual([]);
  });

  it("returns untracked files", async () => {
    await Bun.write(join(repoDir, "new-file.txt"), "hello");

    const result = await harness.callTool("git_status");
    expect(result.untracked).toEqual(["new-file.txt"]);
  });

  it("returns staged files", async () => {
    await Bun.write(join(repoDir, "staged.txt"), "staged content");
    await git(repoDir, "add", "staged.txt");

    const result = await harness.callTool("git_status");
    expect(result.staged).toEqual([{ path: "staged.txt", status: "added" }]);
  });

  it("returns modified files", async () => {
    await Bun.write(join(repoDir, "README.md"), "modified content");

    const result = await harness.callTool("git_status");
    expect(result.modified).toEqual([
      { path: "README.md", status: "modified" },
    ]);
  });

  it("returns staged and modified together", async () => {
    // Stage a new file
    await Bun.write(join(repoDir, "new.txt"), "new");
    await git(repoDir, "add", "new.txt");
    // Modify an existing tracked file
    await Bun.write(join(repoDir, "README.md"), "changed");
    // Create an untracked file
    await Bun.write(join(repoDir, "untracked.txt"), "untracked");

    const result = await harness.callTool("git_status");
    expect(result.staged).toEqual([{ path: "new.txt", status: "added" }]);
    expect(result.modified).toEqual([
      { path: "README.md", status: "modified" },
    ]);
    expect(result.untracked).toEqual(["untracked.txt"]);
  });
});

describe("git_stage", () => {
  it("stages specific files", async () => {
    await Bun.write(join(repoDir, "a.txt"), "a");
    await Bun.write(join(repoDir, "b.txt"), "b");

    const result = await harness.callTool("git_stage", {
      paths: ["a.txt", "b.txt"],
    });
    expect(result.staged).toEqual(["a.txt", "b.txt"]);

    // Verify they are actually staged
    const status = await harness.callTool("git_status");
    const stagedPaths = (status.staged as StatusEntry[]).map((s) => s.path);
    expect(stagedPaths).toContain("a.txt");
    expect(stagedPaths).toContain("b.txt");
  });

  it("refuses to stage '.'", async () => {
    const result = await harness.callTool("git_stage", { paths: ["."] });
    expect(result._isError).toBe(true);
    expect(result.error).toBe("Must specify individual file paths");
  });

  it("refuses to stage '*'", async () => {
    const result = await harness.callTool("git_stage", { paths: ["*"] });
    expect(result._isError).toBe(true);
    expect(result.error).toBe("Must specify individual file paths");
  });

  it("refuses to stage '-A'", async () => {
    const result = await harness.callTool("git_stage", { paths: ["-A"] });
    expect(result._isError).toBe(true);
    expect(result.error).toBe("Must specify individual file paths");
  });

  it("refuses to stage '--all'", async () => {
    const result = await harness.callTool("git_stage", { paths: ["--all"] });
    expect(result._isError).toBe(true);
    expect(result.error).toBe("Must specify individual file paths");
  });
});

describe("agent_commit_changes", () => {
  it("commits staged files", async () => {
    await Bun.write(join(repoDir, "file.txt"), "content");
    await git(repoDir, "add", "file.txt");

    const result = await harness.callTool("agent_commit_changes", {
      message: "add file.txt",
    });
    expect(result._isError).toBe(false);
    expect(result.commitHash).toBeDefined();
    expect(typeof result.commitHash).toBe("string");
    expect((result.commitHash as string).length).toBe(40);
    expect(result.message).toBe("add file.txt");
    expect(result.filesChanged).toBe(1);
  });

  it("auto-stages files when files param is provided", async () => {
    await Bun.write(join(repoDir, "auto.txt"), "auto-staged");

    const result = await harness.callTool("agent_commit_changes", {
      message: "auto-stage and commit",
      files: ["auto.txt"],
    });
    expect(result._isError).toBe(false);
    expect(result.commitHash).toBeDefined();
    expect(result.filesChanged).toBe(1);

    // Verify the commit is in the log
    const log = await git(repoDir, "log", "--oneline", "-1");
    expect(log).toContain("auto-stage and commit");
  });

  it("errors when nothing is staged", async () => {
    const result = await harness.callTool("agent_commit_changes", {
      message: "empty commit",
    });
    expect(result._isError).toBe(true);
    expect(result.error).toBe("Nothing staged to commit");
  });
});

describe("check_merge_conflicts", () => {
  it("detects no conflicts", async () => {
    // Create a feature branch with a non-conflicting change
    await git(repoDir, "checkout", "-b", "feature");
    await Bun.write(join(repoDir, "feature.txt"), "feature content");
    await git(repoDir, "add", "feature.txt");
    await git(repoDir, "commit", "-m", "add feature file");

    const result = await harness.callTool("check_merge_conflicts");
    expect(result.hasConflicts).toBe(false);
    expect(result.targetBranch).toBe("main");
  });

  it("detects conflicts", async () => {
    // Create a feature branch from main (both diverge from same ancestor)
    await git(repoDir, "checkout", "-b", "feature");
    await Bun.write(join(repoDir, "README.md"), "feature content\n");
    await git(repoDir, "add", "README.md");
    await git(repoDir, "commit", "-m", "conflicting change on feature");

    // Go back to main and create a conflicting change
    await git(repoDir, "checkout", "main");
    await Bun.write(join(repoDir, "README.md"), "main content\n");
    await git(repoDir, "add", "README.md");
    await git(repoDir, "commit", "-m", "conflicting change on main");

    // Switch back to feature and check for conflicts
    await git(repoDir, "checkout", "feature");

    const result = await harness.callTool("check_merge_conflicts");
    expect(result.hasConflicts).toBe(true);
    expect(result.targetBranch).toBe("main");
    expect(result.conflictedFiles).toContain("README.md");
  });

  it("defaults to main branch", async () => {
    await git(repoDir, "checkout", "-b", "feature");
    await Bun.write(join(repoDir, "new.txt"), "new content");
    await git(repoDir, "add", "new.txt");
    await git(repoDir, "commit", "-m", "feature commit");

    const result = await harness.callTool("check_merge_conflicts");
    expect(result.targetBranch).toBe("main");
  });

  it("uses specified target branch", async () => {
    await git(repoDir, "checkout", "-b", "develop");
    await Bun.write(join(repoDir, "dev.txt"), "dev content");
    await git(repoDir, "add", "dev.txt");
    await git(repoDir, "commit", "-m", "develop commit");

    await git(repoDir, "checkout", "-b", "feature");
    await Bun.write(join(repoDir, "feat.txt"), "feature content");
    await git(repoDir, "add", "feat.txt");
    await git(repoDir, "commit", "-m", "feature commit");

    const result = await harness.callTool("check_merge_conflicts", {
      targetBranch: "develop",
    });
    expect(result.hasConflicts).toBe(false);
    expect(result.targetBranch).toBe("develop");
  });
});

type StatusEntry = { path: string; status: string };
