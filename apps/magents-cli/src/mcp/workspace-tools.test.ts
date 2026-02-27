import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MagentsMcpServer } from "./server";
import { registerWorkspaceTools } from "./workspace-tools";

async function initGitRepo(dir: string): Promise<void> {
  const run = (args: string[]) =>
    Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" }).exited;

  await run(["init"]);
  await run(["config", "user.email", "test@test.com"]);
  await run(["config", "user.name", "Test"]);
  // Create an initial commit so we have a branch
  await Bun.write(join(dir, ".gitkeep"), "");
  await run(["add", "."]);
  await run(["commit", "-m", "init"]);
}

function parseToolResult(result: { content: unknown }): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

async function setupClientAndServer(workspacePath: string) {
  const server = new MagentsMcpServer(workspacePath);
  server.registerTools([registerWorkspaceTools]);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    client.connect(clientTransport),
    server.mcpServer.connect(serverTransport),
  ]);

  return { client, server };
}

describe("workspace-tools", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "magents-ws-test-")));
    await initGitRepo(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("set_workspace_title", () => {
    it("writes metadata.json and renames the branch", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "set_workspace_title",
        arguments: { title: "Fix Login Bug" },
      });
      const parsed = parseToolResult(result);

      expect(parsed.title).toBe("Fix Login Bug");
      expect(parsed.branch).toBe("fix-login-bug");
      expect(parsed.warning).toBeUndefined();

      // Verify metadata.json was written
      const metadataFile = Bun.file(join(tmpDir, ".workspace", "metadata.json"));
      const metadata = JSON.parse(await metadataFile.text());
      expect(metadata.title).toBe("Fix Login Bug");
      expect(metadata.updatedAt).toBeDefined();

      // Verify git branch was renamed
      const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: tmpDir,
        stdout: "pipe",
      });
      const branch = (await new Response(proc.stdout).text()).trim();
      expect(branch).toBe("fix-login-bug");

      await client.close();
      await server.mcpServer.close();
    });

    it("handles branch rename failure gracefully", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      // Create a branch with the target name so rename will conflict
      const createProc = Bun.spawn(["git", "branch", "my-title"], {
        cwd: tmpDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      await createProc.exited;

      const result = await client.callTool({
        name: "set_workspace_title",
        arguments: { title: "My Title" },
      });
      const parsed = parseToolResult(result);

      expect(parsed.title).toBe("My Title");
      expect(parsed.warning).toBeDefined();
      expect(typeof parsed.warning).toBe("string");

      // Metadata should still be written
      const metadataFile = Bun.file(join(tmpDir, ".workspace", "metadata.json"));
      const metadata = JSON.parse(await metadataFile.text());
      expect(metadata.title).toBe("My Title");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("get_workspace_details", () => {
    it("returns correct metadata", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      // Set up some metadata first
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(tmpDir, ".workspace"), { recursive: true });
      await Bun.write(
        join(tmpDir, ".workspace", "metadata.json"),
        JSON.stringify({ title: "Test Project", updatedAt: "2026-01-01T00:00:00.000Z" }),
      );

      const result = await client.callTool({
        name: "get_workspace_details",
        arguments: {},
      });
      const parsed = parseToolResult(result);

      expect(parsed.title).toBe("Test Project");
      expect(parsed.branch).toBeDefined();
      expect(parsed.repoPath).toBe(tmpDir);
      expect(parsed.workspacePath).toBe(tmpDir);

      await client.close();
      await server.mcpServer.close();
    });

    it("works when metadata.json does not exist", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "get_workspace_details",
        arguments: {},
      });
      const parsed = parseToolResult(result);

      expect(parsed.title).toBeNull();
      expect(parsed.branch).toBeDefined();
      expect(parsed.repoPath).toBe(tmpDir);
      expect(parsed.workspacePath).toBe(tmpDir);

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("set_agent_name", () => {
    it("creates new agent metadata", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "set_agent_name",
        arguments: { agentId: "agent-123", name: "Bug Fixer" },
      });
      const parsed = parseToolResult(result);

      expect(parsed.agentId).toBe("agent-123");
      expect(parsed.name).toBe("Bug Fixer");

      // Verify file was created
      const agentFile = Bun.file(
        join(tmpDir, ".workspace", "agents", "agent-123.json"),
      );
      const agentData = JSON.parse(await agentFile.text());
      expect(agentData.agentId).toBe("agent-123");
      expect(agentData.name).toBe("Bug Fixer");
      expect(agentData.updatedAt).toBeDefined();

      await client.close();
      await server.mcpServer.close();
    });

    it("updates existing agent metadata", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      // Create initial agent file
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(tmpDir, ".workspace", "agents"), { recursive: true });
      await Bun.write(
        join(tmpDir, ".workspace", "agents", "agent-456.json"),
        JSON.stringify({
          agentId: "agent-456",
          name: "Old Name",
          customField: "preserved",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      const result = await client.callTool({
        name: "set_agent_name",
        arguments: { agentId: "agent-456", name: "New Name" },
      });
      const parsed = parseToolResult(result);

      expect(parsed.agentId).toBe("agent-456");
      expect(parsed.name).toBe("New Name");

      // Verify existing fields are preserved
      const agentFile = Bun.file(
        join(tmpDir, ".workspace", "agents", "agent-456.json"),
      );
      const agentData = JSON.parse(await agentFile.text());
      expect(agentData.name).toBe("New Name");
      expect(agentData.customField).toBe("preserved");

      await client.close();
      await server.mcpServer.close();
    });
  });
});
