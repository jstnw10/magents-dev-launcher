import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "./types.js";
import { registerEventTools } from "./event-tools.js";
import { appendEvent } from "./event-storage.js";

async function gitCmd(cwd: string, ...args: string[]): Promise<string> {
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
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "event-tools-test-")),
  );
  await gitCmd(dir, "init", "-b", "main");
  await gitCmd(dir, "config", "user.email", "test@test.com");
  await gitCmd(dir, "config", "user.name", "Test");
  await Bun.write(join(dir, "README.md"), "# Test Repo\n");
  await gitCmd(dir, "add", "README.md");
  await gitCmd(dir, "commit", "-m", "initial commit");
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

async function createTestHarness(
  workspacePath: string,
): Promise<TestHarness> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const context: ToolContext = { workspacePath };
  registerEventTools(server, context);

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

describe("read_timeline", () => {
  it("returns events", async () => {
    await appendEvent(repoDir, {
      type: "file:changed",
      actor: { type: "user" },
      data: { path: "test.ts" },
    });

    const result = await harness.callTool("read_timeline");
    expect(result.count).toBe(1);
    const events = result.events as Array<Record<string, unknown>>;
    expect(events[0].type).toBe("file:changed");
  });

  it("filters by type", async () => {
    await appendEvent(repoDir, {
      type: "file:changed",
      actor: { type: "user" },
      data: {},
    });
    await appendEvent(repoDir, {
      type: "agent:idle",
      actor: { type: "agent" },
      data: {},
    });

    const result = await harness.callTool("read_timeline", {
      type: "agent:idle",
    });
    expect(result.count).toBe(1);
    const events = result.events as Array<Record<string, unknown>>;
    expect(events[0].type).toBe("agent:idle");
  });

  it("returns empty when no events", async () => {
    const result = await harness.callTool("read_timeline");
    expect(result.count).toBe(0);
    expect(result.events).toEqual([]);
  });
});

describe("get_recent_files", () => {
  it("returns files from git", async () => {
    await Bun.write(join(repoDir, "new-file.ts"), "content");
    await gitCmd(repoDir, "add", "new-file.ts");
    await gitCmd(repoDir, "commit", "-m", "add new file");

    const result = await harness.callTool("get_recent_files");
    expect((result.count as number) > 0).toBe(true);
    const files = result.files as Array<{ path: string }>;
    expect(files.some((f) => f.path === "new-file.ts")).toBe(true);
  });

  it("respects limit parameter", async () => {
    await Bun.write(join(repoDir, "a.ts"), "a");
    await Bun.write(join(repoDir, "b.ts"), "b");
    await gitCmd(repoDir, "add", ".");
    await gitCmd(repoDir, "commit", "-m", "add files");

    const result = await harness.callTool("get_recent_files", { limit: 1 });
    expect(result.count).toBe(1);
  });
});

describe("get_agent_activity", () => {
  it("returns agent metadata", async () => {
    const agentsDir = join(repoDir, ".workspace", "opencode", "agents");
    await mkdir(agentsDir, { recursive: true });

    const now = new Date().toISOString();
    await Bun.write(
      join(agentsDir, "agent-test.json"),
      JSON.stringify({
        agentId: "agent-test",
        name: "Test Agent",
        updatedAt: now,
      }),
    );

    const result = await harness.callTool("get_agent_activity");
    expect(result.count).toBe(1);
    const agents = result.agents as Array<{ agentId: string; name: string }>;
    expect(agents[0].agentId).toBe("agent-test");
    expect(agents[0].name).toBe("Test Agent");
  });

  it("returns empty when no agents", async () => {
    const result = await harness.callTool("get_agent_activity");
    expect(result.count).toBe(0);
    expect(result.agents).toEqual([]);
  });
});

describe("get_workspace_summary", () => {
  it("returns combined summary", async () => {
    await appendEvent(repoDir, {
      type: "file:changed",
      actor: { type: "user" },
      data: {},
    });

    const result = await harness.callTool("get_workspace_summary");
    expect(result.eventCountsByType).toBeDefined();
    const counts = result.eventCountsByType as Record<string, number>;
    expect(counts["file:changed"]).toBe(1);
    expect(typeof result.activeAgentCount).toBe("number");
    expect(typeof result.recentFileCount).toBe("number");
    expect(result.gitStatus).toBeDefined();
  });
});

describe("get_directory_changes", () => {
  it("returns changes scoped to directory", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true });
    await Bun.write(join(repoDir, "src", "app.ts"), "app content");
    await Bun.write(join(repoDir, "root.ts"), "root content");
    await gitCmd(repoDir, "add", ".");
    await gitCmd(repoDir, "commit", "-m", "add files");

    const result = await harness.callTool("get_directory_changes", {
      directory: "src",
    });
    expect((result.count as number) > 0).toBe(true);
    const changes = result.changes as Array<{ path: string }>;
    expect(changes.every((c) => c.path.startsWith("src/"))).toBe(true);
  });

  it("returns empty for directory with no changes", async () => {
    const result = await harness.callTool("get_directory_changes", {
      directory: "nonexistent",
    });
    expect(result.count).toBe(0);
  });
});

describe("query_events", () => {
  it("filters with multiple criteria", async () => {
    await appendEvent(repoDir, {
      type: "file:changed",
      actor: { type: "user" },
      data: { path: "src/a.ts" },
    });
    await appendEvent(repoDir, {
      type: "file:changed",
      actor: { type: "agent", id: "agent-1" },
      data: { path: "src/b.ts" },
    });
    await appendEvent(repoDir, {
      type: "agent:idle",
      actor: { type: "agent", id: "agent-1" },
      data: {},
    });

    const result = await harness.callTool("query_events", {
      eventType: "file:changed",
      actorType: "agent",
    });
    expect(result.count).toBe(1);
    const events = result.events as Array<Record<string, unknown>>;
    const data = events[0].data as Record<string, unknown>;
    expect(data.path).toBe("src/b.ts");
  });

  it("filters by path prefix", async () => {
    await appendEvent(repoDir, {
      type: "file:changed",
      actor: { type: "user" },
      data: { path: "src/components/Button.tsx" },
    });
    await appendEvent(repoDir, {
      type: "file:changed",
      actor: { type: "user" },
      data: { path: "test/app.test.ts" },
    });

    const result = await harness.callTool("query_events", {
      path: "src/",
    });
    expect(result.count).toBe(1);
  });

  it("returns all events with no filters", async () => {
    await appendEvent(repoDir, {
      type: "a",
      actor: { type: "system" },
      data: {},
    });
    await appendEvent(repoDir, {
      type: "b",
      actor: { type: "system" },
      data: {},
    });

    const result = await harness.callTool("query_events", {});
    expect(result.count).toBe(2);
  });
});
