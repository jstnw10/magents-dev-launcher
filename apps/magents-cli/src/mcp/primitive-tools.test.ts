import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MagentsMcpServer } from "./server";
import { registerPrimitiveTools } from "./primitive-tools";
import { saveNote, loadNote, type Note } from "./note-storage";

function parseToolResult(result: { content: unknown }): unknown {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

function getToolText(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

async function setupClientAndServer(workspacePath: string) {
  const server = new MagentsMcpServer(workspacePath);
  server.registerTools([registerPrimitiveTools]);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    client.connect(clientTransport),
    server.mcpServer.connect(serverTransport),
  ]);

  return { client, server };
}

async function createTestNote(
  workspacePath: string,
  overrides: Partial<Note> = {},
): Promise<Note> {
  const now = new Date().toISOString();
  const note: Note = {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? "Test Note",
    content: overrides.content ?? "Test content",
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
  await saveNote(workspacePath, note);
  return note;
}

/** Extract ws-block JSON from note content */
function extractWsBlock(content: string, type: string): unknown {
  const regex = new RegExp(
    "```ws-block:" + type + "\\n([\\s\\S]*?)\\n```",
  );
  const match = content.match(regex);
  if (!match) return null;
  return JSON.parse(match[1]);
}

describe("primitive-tools", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "magents-pt-test-")));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("add_reference_primitive", () => {
    it("appends ws-block:reference to note", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, { content: "Existing content" });

      const result = await client.callTool({
        name: "add_reference_primitive",
        arguments: {
          noteId: note.id,
          semanticId: "src/main.ts#L10-20",
          description: "Main entry point",
        },
      });

      const parsed = parseToolResult(result) as { primitiveId: string; noteId: string };
      expect(parsed.primitiveId).toBeDefined();
      expect(parsed.noteId).toBe(note.id);

      const updated = await loadNote(tmpDir, note.id);
      expect(updated!.content).toContain("```ws-block:reference");
      const block = extractWsBlock(updated!.content, "reference") as Record<string, unknown>;
      expect(block.type).toBe("reference");
      expect(block.description).toBe("Main entry point");
      expect((block.target as Record<string, unknown>).kind).toBe("file_range");

      await client.close();
      await server.mcpServer.close();
    });

    it("includes snapshot data when provided", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, { content: "Content" });

      await client.callTool({
        name: "add_reference_primitive",
        arguments: {
          noteId: note.id,
          semanticId: "src/utils.ts#L1-5",
          description: "Utility function",
          snapshot: "export function add(a: number, b: number) { return a + b; }",
        },
      });

      const updated = await loadNote(tmpDir, note.id);
      const block = extractWsBlock(updated!.content, "reference") as Record<string, unknown>;
      const snap = block.snapshot as Record<string, unknown>;
      expect(snap.code).toBe("export function add(a: number, b: number) { return a + b; }");
      expect(snap.filePath).toBe("src/utils.ts");
      expect(snap.language).toBe("ts");

      await client.close();
      await server.mcpServer.close();
    });

    it("detects symbol vs file_range kind", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, { content: "Content" });

      // Symbol kind
      await client.callTool({
        name: "add_reference_primitive",
        arguments: {
          noteId: note.id,
          semanticId: "src/main.ts#symbol:MainClass.init",
          description: "Init method",
        },
      });

      const updated = await loadNote(tmpDir, note.id);
      const block = extractWsBlock(updated!.content, "reference") as Record<string, unknown>;
      expect((block.target as Record<string, unknown>).kind).toBe("symbol");

      await client.close();
      await server.mcpServer.close();
    });

    it("returns error for non-existent note", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "add_reference_primitive",
        arguments: {
          noteId: "nonexistent",
          semanticId: "src/main.ts#L1",
          description: "Test",
        },
      });

      expect(result.isError).toBe(true);
      expect(getToolText(result)).toContain("not found");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("add_cli_primitive", () => {
    it("appends ws-block:cli to note", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, { content: "Existing" });

      const result = await client.callTool({
        name: "add_cli_primitive",
        arguments: {
          noteId: note.id,
          command: "bun test",
          description: "Run tests",
          workingDirectory: "/app",
        },
      });

      const parsed = parseToolResult(result) as { primitiveId: string; noteId: string };
      expect(parsed.primitiveId).toBeDefined();

      const updated = await loadNote(tmpDir, note.id);
      expect(updated!.content).toContain("```ws-block:cli");
      const block = extractWsBlock(updated!.content, "cli") as Record<string, unknown>;
      expect(block.type).toBe("cli");
      expect(block.command).toBe("bun test");
      expect(block.description).toBe("Run tests");
      expect(block.cwd).toBe("/app");

      await client.close();
      await server.mcpServer.close();
    });

    it("uses default cwd when not provided", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, { content: "Content" });

      await client.callTool({
        name: "add_cli_primitive",
        arguments: {
          noteId: note.id,
          command: "ls",
          description: "List files",
        },
      });

      const updated = await loadNote(tmpDir, note.id);
      const block = extractWsBlock(updated!.content, "cli") as Record<string, unknown>;
      expect(block.cwd).toBe("./");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("add_patch_primitive", () => {
    it("appends ws-block:patch to note", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, { content: "Existing" });

      const diff = "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new";
      const result = await client.callTool({
        name: "add_patch_primitive",
        arguments: {
          noteId: note.id,
          filePath: "src/main.ts",
          diff,
          description: "Fix the main file",
        },
      });

      const parsed = parseToolResult(result) as { primitiveId: string; noteId: string };
      expect(parsed.primitiveId).toBeDefined();

      const updated = await loadNote(tmpDir, note.id);
      expect(updated!.content).toContain("```ws-block:patch");
      const block = extractWsBlock(updated!.content, "patch") as Record<string, unknown>;
      expect(block.type).toBe("patch");
      expect(block.description).toBe("Fix the main file");
      const patches = block.patches as Array<Record<string, unknown>>;
      expect(patches[0].filePath).toBe("src/main.ts");
      expect(patches[0].diff).toBe(diff);

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("add_agent_action_primitive", () => {
    it("appends ws-block:agent_action to note", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, { content: "Existing" });

      const result = await client.callTool({
        name: "add_agent_action_primitive",
        arguments: {
          noteId: note.id,
          agentId: "refactor",
          goal: "Refactor the auth module",
          description: "Refactoring agent for auth",
        },
      });

      const parsed = parseToolResult(result) as { primitiveId: string; noteId: string };
      expect(parsed.primitiveId).toBeDefined();

      const updated = await loadNote(tmpDir, note.id);
      expect(updated!.content).toContain("```ws-block:agent_action");
      const block = extractWsBlock(updated!.content, "agent_action") as Record<string, unknown>;
      expect(block.type).toBe("agent_action");
      expect(block.agentId).toBe("refactor");
      expect(block.goal).toBe("Refactor the auth module");
      expect(block.description).toBe("Refactoring agent for auth");
      expect(block.inputs).toEqual([]);

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("get_reference_docs", () => {
    it("returns diagrams documentation", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "get_reference_docs",
        arguments: { topic: "diagrams" },
      });

      const text = getToolText(result);
      expect(text).toContain("Diagram Syntax Reference");
      expect(text).toContain("architecture");
      expect(text).toContain("layered");

      await client.close();
      await server.mcpServer.close();
    });

    it("returns ws-blocks documentation", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "get_reference_docs",
        arguments: { topic: "ws-blocks" },
      });

      const text = getToolText(result);
      expect(text).toContain("WS-Block Syntax Reference");
      expect(text).toContain("reference");
      expect(text).toContain("cli");

      await client.close();
      await server.mcpServer.close();
    });

    it("returns tasks documentation", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "get_reference_docs",
        arguments: { topic: "tasks" },
      });

      const text = getToolText(result);
      expect(text).toContain("Task Syntax Reference");
      expect(text).toContain("@@@task");

      await client.close();
      await server.mcpServer.close();
    });

    it("errors on unknown topic", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "get_reference_docs",
        arguments: { topic: "nonexistent" },
      });

      expect(result.isError).toBe(true);
      const text = getToolText(result);
      expect(text).toContain("Unknown topic");
      expect(text).toContain("diagrams");
      expect(text).toContain("ws-blocks");
      expect(text).toContain("tasks");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("shared behavior", () => {
    it("all primitives get unique UUIDs", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, { content: "Content" });

      const results = await Promise.all([
        client.callTool({
          name: "add_reference_primitive",
          arguments: {
            noteId: note.id,
            semanticId: "src/a.ts#L1",
            description: "Ref A",
          },
        }),
        client.callTool({
          name: "add_cli_primitive",
          arguments: {
            noteId: note.id,
            command: "echo hi",
            description: "Echo",
          },
        }),
      ]);

      const ids = results.map(
        (r) => (parseToolResult(r) as { primitiveId: string }).primitiveId,
      );
      expect(ids[0]).not.toBe(ids[1]);
      expect(ids[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      await client.close();
      await server.mcpServer.close();
    });

    it("appended content is valid JSON inside code fences", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, { content: "Initial" });

      await client.callTool({
        name: "add_cli_primitive",
        arguments: {
          noteId: note.id,
          command: "bun test",
          description: "Run tests",
        },
      });

      const updated = await loadNote(tmpDir, note.id);
      const content = updated!.content;

      // Extract the JSON between code fences
      const match = content.match(/```ws-block:cli\n([\s\S]*?)\n```/);
      expect(match).not.toBeNull();

      // Should be valid JSON
      const json = JSON.parse(match![1]);
      expect(json.type).toBe("cli");
      expect(json.id).toBeDefined();
      expect(json.version).toBe(1);
      expect(json.createdAt).toBeDefined();
      expect(json.createdBy).toBe("agent");

      await client.close();
      await server.mcpServer.close();
    });
  });
});
