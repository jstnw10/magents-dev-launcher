import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MagentsMcpServer } from "./server";
import { registerCrossWorkspaceTools } from "./cross-workspace-tools";
import { saveNote } from "./note-storage";

async function initGitRepo(dir: string): Promise<void> {
  const run = (args: string[]) =>
    Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" })
      .exited;

  await run(["init"]);
  await run(["config", "user.email", "test@test.com"]);
  await run(["config", "user.name", "Test"]);
  await Bun.write(join(dir, ".gitkeep"), "");
  await run(["add", "."]);
  await run(["commit", "-m", "init"]);
}

async function createTestWorkspace(
  parentDir: string,
  id: string,
  title: string,
): Promise<string> {
  const wsPath = join(parentDir, id);
  const wsDir = join(wsPath, ".workspace");
  const notesDir = join(wsDir, "notes");
  await mkdir(notesDir, { recursive: true });
  await Bun.write(
    join(wsDir, "metadata.json"),
    JSON.stringify({ title, updatedAt: new Date().toISOString() }),
  );
  return wsPath;
}

function parseToolResult(result: { content: unknown }): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

async function setupClientAndServer(workspacePath: string) {
  const server = new MagentsMcpServer(workspacePath);
  server.registerTools([registerCrossWorkspaceTools]);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    client.connect(clientTransport),
    server.mcpServer.connect(serverTransport),
  ]);

  return { client, server };
}

describe("cross-workspace-tools", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "magents-xws-test-")));
    await initGitRepo(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("list_sibling_workspaces", () => {
    it("finds sibling workspaces in same repo", async () => {
      const ws1 = await createTestWorkspace(tmpDir, "ws-alpha", "Alpha Project");
      const ws2 = await createTestWorkspace(tmpDir, "ws-beta", "Beta Project");

      const { client, server } = await setupClientAndServer(ws1);

      const result = await client.callTool({
        name: "list_sibling_workspaces",
        arguments: {},
      });
      const parsed = parseToolResult(result);

      expect(parsed.count).toBe(1);
      const workspaces = parsed.workspaces as Array<Record<string, unknown>>;
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].id).toBe("ws-beta");
      expect(workspaces[0].title).toBe("Beta Project");
      expect(workspaces[0].workspacePath).toBe(ws2);

      await client.close();
      await server.mcpServer.close();
    });

    it("returns empty when no siblings", async () => {
      const ws = await createTestWorkspace(tmpDir, "ws-solo", "Solo");

      const { client, server } = await setupClientAndServer(ws);

      const result = await client.callTool({
        name: "list_sibling_workspaces",
        arguments: {},
      });
      const parsed = parseToolResult(result);

      expect(parsed.count).toBe(0);
      expect(parsed.workspaces).toEqual([]);

      await client.close();
      await server.mcpServer.close();
    });

    it("uses registry.json when available", async () => {
      const ws1 = await createTestWorkspace(tmpDir, "ws-one", "One");
      const ws2 = await createTestWorkspace(tmpDir, "ws-two", "Two");

      // Create registry.json at repo root
      await mkdir(join(tmpDir, ".workspace"), { recursive: true });
      await Bun.write(
        join(tmpDir, ".workspace", "registry.json"),
        JSON.stringify([
          { id: "ws-one", path: ws1, repoPath: tmpDir },
          { id: "ws-two", path: ws2, repoPath: tmpDir },
        ]),
      );

      const { client, server } = await setupClientAndServer(ws1);

      const result = await client.callTool({
        name: "list_sibling_workspaces",
        arguments: {},
      });
      const parsed = parseToolResult(result);

      expect(parsed.count).toBe(1);
      const workspaces = parsed.workspaces as Array<Record<string, unknown>>;
      expect(workspaces[0].id).toBe("ws-two");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("read_external_note", () => {
    it("reads note from sibling workspace", async () => {
      const ws1 = await createTestWorkspace(tmpDir, "ws-reader", "Reader");
      const ws2 = await createTestWorkspace(tmpDir, "ws-writer", "Writer");

      // Create a note in ws2
      await saveNote(ws2, {
        id: "test-note",
        title: "Test Note",
        content: "Hello from writer workspace",
        tags: ["test"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const { client, server } = await setupClientAndServer(ws1);

      const result = await client.callTool({
        name: "read_external_note",
        arguments: { targetWorkspaceId: "ws-writer", noteId: "test-note" },
      });
      const parsed = parseToolResult(result);

      expect(parsed.id).toBe("test-note");
      expect(parsed.title).toBe("Test Note");
      expect(parsed.tags).toEqual(["test"]);
      expect((parsed.content as string)).toContain("Hello from writer workspace");

      await client.close();
      await server.mcpServer.close();
    });

    it("formats content with line numbers", async () => {
      const ws1 = await createTestWorkspace(tmpDir, "ws-a", "A");
      const ws2 = await createTestWorkspace(tmpDir, "ws-b", "B");

      await saveNote(ws2, {
        id: "multiline",
        title: "Multi",
        content: "line one\nline two\nline three",
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const { client, server } = await setupClientAndServer(ws1);

      const result = await client.callTool({
        name: "read_external_note",
        arguments: { targetWorkspaceId: "ws-b", noteId: "multiline" },
      });
      const parsed = parseToolResult(result);

      const content = parsed.content as string;
      expect(content).toContain("   1 | line one");
      expect(content).toContain("   2 | line two");
      expect(content).toContain("   3 | line three");

      await client.close();
      await server.mcpServer.close();
    });

    it("errors on nonexistent note", async () => {
      const ws1 = await createTestWorkspace(tmpDir, "ws-x", "X");
      await createTestWorkspace(tmpDir, "ws-y", "Y");

      const { client, server } = await setupClientAndServer(ws1);

      const result = await client.callTool({
        name: "read_external_note",
        arguments: { targetWorkspaceId: "ws-y", noteId: "does-not-exist" },
      });
      const parsed = parseToolResult(result);

      expect(parsed.error).toBeDefined();
      expect((parsed.error as string)).toContain("not found");

      await client.close();
      await server.mcpServer.close();
    });

    it("errors on nonexistent workspace", async () => {
      const ws1 = await createTestWorkspace(tmpDir, "ws-only", "Only");

      const { client, server } = await setupClientAndServer(ws1);

      const result = await client.callTool({
        name: "read_external_note",
        arguments: { targetWorkspaceId: "ws-phantom", noteId: "any" },
      });
      const parsed = parseToolResult(result);

      expect(parsed.error).toBeDefined();
      expect((parsed.error as string)).toContain("not found");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("list_external_notes", () => {
    it("lists notes from sibling workspace", async () => {
      const ws1 = await createTestWorkspace(tmpDir, "ws-lister", "Lister");
      const ws2 = await createTestWorkspace(tmpDir, "ws-target", "Target");

      // Create notes in ws2
      await saveNote(ws2, {
        id: "note-1",
        title: "First Note",
        content: "content 1",
        tags: ["tag-a"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await saveNote(ws2, {
        id: "note-2",
        title: "Second Note",
        content: "content 2",
        tags: ["tag-b"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const { client, server } = await setupClientAndServer(ws1);

      const result = await client.callTool({
        name: "list_external_notes",
        arguments: { targetWorkspaceId: "ws-target" },
      });
      const parsed = parseToolResult(result);

      expect(parsed.count).toBe(2);
      const notes = parsed.notes as Array<Record<string, unknown>>;
      const ids = notes.map((n) => n.id);
      expect(ids).toContain("note-1");
      expect(ids).toContain("note-2");

      await client.close();
      await server.mcpServer.close();
    });

    it("returns empty for workspace with no notes", async () => {
      const ws1 = await createTestWorkspace(tmpDir, "ws-empty-lister", "EL");
      await createTestWorkspace(tmpDir, "ws-empty-target", "ET");

      const { client, server } = await setupClientAndServer(ws1);

      const result = await client.callTool({
        name: "list_external_notes",
        arguments: { targetWorkspaceId: "ws-empty-target" },
      });
      const parsed = parseToolResult(result);

      expect(parsed.count).toBe(0);
      expect(parsed.notes).toEqual([]);

      await client.close();
      await server.mcpServer.close();
    });
  });
});
