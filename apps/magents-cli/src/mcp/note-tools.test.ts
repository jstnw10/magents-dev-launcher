import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MagentsMcpServer } from "./server";
import { registerNoteTools } from "./note-tools";
import { saveNote, type Note } from "./note-storage";

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
  server.registerTools([registerNoteTools]);

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

describe("note-tools", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "magents-nt-test-")));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("create_note", () => {
    it("creates and returns id", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "create_note",
        arguments: { title: "My Note", content: "Hello", tags: "a, b" },
      });
      const parsed = parseToolResult(result) as { id: string; title: string };

      expect(parsed.id).toBeDefined();
      expect(parsed.title).toBe("My Note");

      // Verify file exists
      const file = Bun.file(
        join(tmpDir, ".workspace", "notes", `${parsed.id}.json`),
      );
      expect(await file.exists()).toBe(true);
      const data = JSON.parse(await file.text());
      expect(data.tags).toEqual(["a", "b"]);

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("list_notes", () => {
    it("returns created notes", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      await createTestNote(tmpDir, { title: "Note A", tags: ["x"] });
      await createTestNote(tmpDir, { title: "Note B", tags: ["y"] });

      const result = await client.callTool({
        name: "list_notes",
        arguments: {},
      });
      const parsed = parseToolResult(result) as Array<{ title: string }>;

      expect(parsed).toHaveLength(2);
      const titles = parsed.map((n) => n.title);
      expect(titles).toContain("Note A");
      expect(titles).toContain("Note B");

      await client.close();
      await server.mcpServer.close();
    });

    it("filters by tag", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      await createTestNote(tmpDir, { title: "Tagged", tags: ["important"] });
      await createTestNote(tmpDir, { title: "Untagged", tags: [] });

      const result = await client.callTool({
        name: "list_notes",
        arguments: { tag: "important" },
      });
      const parsed = parseToolResult(result) as Array<{ title: string }>;

      expect(parsed).toHaveLength(1);
      expect(parsed[0].title).toBe("Tagged");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("read_note", () => {
    it("returns content with line numbers", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        title: "Readable",
        content: "line one\nline two\nline three",
      });

      const result = await client.callTool({
        name: "read_note",
        arguments: { noteId: note.id },
      });
      const text = getToolText(result);

      expect(text).toContain("Note: Readable");
      expect(text).toContain("1 | line one");
      expect(text).toContain("2 | line two");
      expect(text).toContain("3 | line three");

      await client.close();
      await server.mcpServer.close();
    });

    it("auto-creates spec if needed", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "read_note",
        arguments: { noteId: "spec" },
      });
      const text = getToolText(result);

      expect(text).toContain("Note: Spec");

      // Verify spec file was created
      const file = Bun.file(join(tmpDir, ".workspace", "notes", "spec.json"));
      expect(await file.exists()).toBe(true);

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("delete_note", () => {
    it("removes note", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, { title: "Delete Me" });

      const result = await client.callTool({
        name: "delete_note",
        arguments: { noteId: note.id },
      });
      const parsed = parseToolResult(result) as { deleted: boolean };
      expect(parsed.deleted).toBe(true);

      const file = Bun.file(
        join(tmpDir, ".workspace", "notes", `${note.id}.json`),
      );
      expect(await file.exists()).toBe(false);

      await client.close();
      await server.mcpServer.close();
    });

    it("refuses to delete spec", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "delete_note",
        arguments: { noteId: "spec" },
      });

      expect(result.isError).toBe(true);
      const text = getToolText(result);
      expect(text).toContain("Cannot delete the spec note");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("set_note_content", () => {
    it("replaces content", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, { content: "old content" });

      const result = await client.callTool({
        name: "set_note_content",
        arguments: { noteId: note.id, content: "new content" },
      });
      const parsed = parseToolResult(result) as { updated: boolean };
      expect(parsed.updated).toBe(true);

      // Verify content was replaced
      const file = Bun.file(
        join(tmpDir, ".workspace", "notes", `${note.id}.json`),
      );
      const data = JSON.parse(await file.text());
      expect(data.content).toBe("new content");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("add_to_note", () => {
    it("appends at end by default", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, { content: "existing" });

      await client.callTool({
        name: "add_to_note",
        arguments: { noteId: note.id, content: "appended" },
      });

      const file = Bun.file(
        join(tmpDir, ".workspace", "notes", `${note.id}.json`),
      );
      const data = JSON.parse(await file.text());
      expect(data.content).toBe("existing\nappended");

      await client.close();
      await server.mcpServer.close();
    });

    it("prepends at start", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, { content: "existing" });

      await client.callTool({
        name: "add_to_note",
        arguments: { noteId: note.id, content: "prepended", position: "start" },
      });

      const file = Bun.file(
        join(tmpDir, ".workspace", "notes", `${note.id}.json`),
      );
      const data = JSON.parse(await file.text());
      expect(data.content).toBe("prepended\nexisting");

      await client.close();
      await server.mcpServer.close();
    });

    it("inserts after heading", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "## Section 1\nContent 1\n## Section 2\nContent 2",
      });

      await client.callTool({
        name: "add_to_note",
        arguments: {
          noteId: note.id,
          content: "Inserted content",
          position: "after:## Section 1",
        },
      });

      const file = Bun.file(
        join(tmpDir, ".workspace", "notes", `${note.id}.json`),
      );
      const data = JSON.parse(await file.text());
      expect(data.content).toBe(
        "## Section 1\nContent 1\nInserted content\n## Section 2\nContent 2",
      );

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("edit_note", () => {
    it("replaces exact text", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "Hello world, this is a test",
      });

      await client.callTool({
        name: "edit_note",
        arguments: {
          noteId: note.id,
          old_text: "Hello world",
          new_text: "Goodbye world",
        },
      });

      const file = Bun.file(
        join(tmpDir, ".workspace", "notes", `${note.id}.json`),
      );
      const data = JSON.parse(await file.text());
      expect(data.content).toBe("Goodbye world, this is a test");

      await client.close();
      await server.mcpServer.close();
    });

    it("fails on not-found text", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, { content: "Hello world" });

      const result = await client.callTool({
        name: "edit_note",
        arguments: {
          noteId: note.id,
          old_text: "nonexistent",
          new_text: "replacement",
        },
      });

      expect(result.isError).toBe(true);
      const text = getToolText(result);
      expect(text).toContain("not found");

      await client.close();
      await server.mcpServer.close();
    });

    it("fails on ambiguous (multiple matches)", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "foo bar foo baz foo",
      });

      const result = await client.callTool({
        name: "edit_note",
        arguments: {
          noteId: note.id,
          old_text: "foo",
          new_text: "qux",
        },
      });

      expect(result.isError).toBe(true);
      const text = getToolText(result);
      expect(text).toContain("3 times");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("edit_note_lines", () => {
    it("replaces line range", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "line 1\nline 2\nline 3\nline 4",
      });

      await client.callTool({
        name: "edit_note_lines",
        arguments: {
          noteId: note.id,
          start_line: "2",
          end_line: "3",
          new_content: "replaced",
        },
      });

      const file = Bun.file(
        join(tmpDir, ".workspace", "notes", `${note.id}.json`),
      );
      const data = JSON.parse(await file.text());
      expect(data.content).toBe("line 1\nreplaced\nline 4");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("update_note_metadata", () => {
    it("changes title and tags", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        title: "Old Title",
        tags: ["old"],
      });

      await client.callTool({
        name: "update_note_metadata",
        arguments: {
          noteId: note.id,
          title: "New Title",
          tags: "new, updated",
        },
      });

      const file = Bun.file(
        join(tmpDir, ".workspace", "notes", `${note.id}.json`),
      );
      const data = JSON.parse(await file.text());
      expect(data.title).toBe("New Title");
      expect(data.tags).toEqual(["new", "updated"]);
      // Content should be unchanged
      expect(data.content).toBe("Test content");

      await client.close();
      await server.mcpServer.close();
    });
  });
});
