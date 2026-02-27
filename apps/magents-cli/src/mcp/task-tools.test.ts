import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MagentsMcpServer } from "./server";
import { registerTaskTools } from "./task-tools";
import { saveNote, loadNote, listNotes, type Note } from "./note-storage";

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
  server.registerTools([registerTaskTools]);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
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

describe("task-tools", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "magents-tt-test-")));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("list_note_tasks", () => {
    it("parses checkboxes correctly (todo, done, in-progress)", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content:
          "# Plan\n- [ ] First task\n- [x] Done task\n- [/] In progress task\nSome other text",
      });

      const result = await client.callTool({
        name: "list_note_tasks",
        arguments: { noteId: note.id },
      });
      const text = getToolText(result);

      // Parse the JSON array from the end of the response
      const jsonStr = text.substring(text.indexOf("\n\n") + 2);
      const tasks = JSON.parse(jsonStr);

      expect(tasks).toHaveLength(3);
      expect(tasks[0]).toEqual({
        line: 2,
        text: "First task",
        status: "todo",
      });
      expect(tasks[1]).toEqual({
        line: 3,
        text: "Done task",
        status: "done",
      });
      expect(tasks[2]).toEqual({
        line: 4,
        text: "In progress task",
        status: "in-progress",
      });

      await client.close();
      await server.mcpServer.close();
    });

    it("extracts linked task IDs from intent:// URLs", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content:
          "- [ ] [Build auth](intent://local/task/abc-123)\n- [x] [Setup DB](intent://local/task/def-456)",
      });

      const result = await client.callTool({
        name: "list_note_tasks",
        arguments: { noteId: note.id },
      });
      const text = getToolText(result);
      // The JSON array starts after the double newline separator
      const jsonStr = text.substring(text.indexOf("\n\n") + 2);
      const tasks = JSON.parse(jsonStr);

      expect(tasks).toHaveLength(2);
      expect(tasks[0].linkedTaskNoteId).toBe("abc-123");
      expect(tasks[1].linkedTaskNoteId).toBe("def-456");

      // Check human-readable summary
      expect(text).toContain("→ task note: abc-123");
      expect(text).toContain("→ task note: def-456");

      await client.close();
      await server.mcpServer.close();
    });

    it("returns empty array for note with no tasks", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "Just some plain text\nNo tasks here",
      });

      const result = await client.callTool({
        name: "list_note_tasks",
        arguments: { noteId: note.id },
      });
      const text = getToolText(result);
      const jsonStr = text.substring(text.indexOf("\n\n") + 2);
      const tasks = JSON.parse(jsonStr);

      expect(tasks).toHaveLength(0);
      expect(text).toContain("(0 tasks)");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("update_task", () => {
    it("changes status on a specific line", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "- [ ] Task one\n- [ ] Task two",
      });

      const result = await client.callTool({
        name: "update_task",
        arguments: { noteId: note.id, lineNumber: 1, status: "done" },
      });
      const parsed = parseToolResult(result) as { updated: boolean };
      expect(parsed.updated).toBe(true);

      const updated = await loadNote(tmpDir, note.id);
      const lines = updated!.content.split("\n");
      expect(lines[0]).toBe("- [x] Task one");
      expect(lines[1]).toBe("- [ ] Task two");

      await client.close();
      await server.mcpServer.close();
    });

    it("changes text on a specific line", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "- [ ] Old text\n- [x] Done item",
      });

      await client.callTool({
        name: "update_task",
        arguments: { noteId: note.id, lineNumber: 1, newText: "New text" },
      });

      const updated = await loadNote(tmpDir, note.id);
      expect(updated!.content.split("\n")[0]).toBe("- [ ] New text");

      await client.close();
      await server.mcpServer.close();
    });

    it("fails if line is not a task", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "# Heading\n- [ ] A task",
      });

      const result = await client.callTool({
        name: "update_task",
        arguments: { noteId: note.id, lineNumber: 1, status: "done" },
      });

      expect(result.isError).toBe(true);
      expect(getToolText(result)).toContain("not a task checkbox line");

      await client.close();
      await server.mcpServer.close();
    });

    it("fails if line number out of range", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "- [ ] Only task",
      });

      const result = await client.callTool({
        name: "update_task",
        arguments: { noteId: note.id, lineNumber: 5, status: "done" },
      });

      expect(result.isError).toBe(true);
      expect(getToolText(result)).toContain("out of range");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("update_task_status", () => {
    it("finds task by text and updates status", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "- [ ] Build auth system\n- [ ] Setup database\n- [/] Design API",
      });

      const result = await client.callTool({
        name: "update_task_status",
        arguments: {
          noteId: note.id,
          taskText: "Setup database",
          status: "done",
        },
      });
      const parsed = parseToolResult(result) as { updated: boolean };
      expect(parsed.updated).toBe(true);

      const updated = await loadNote(tmpDir, note.id);
      const lines = updated!.content.split("\n");
      expect(lines[0]).toBe("- [ ] Build auth system");
      expect(lines[1]).toBe("- [x] Setup database");
      expect(lines[2]).toBe("- [/] Design API");

      await client.close();
      await server.mcpServer.close();
    });

    it("fails if task text not found", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "- [ ] Existing task",
      });

      const result = await client.callTool({
        name: "update_task_status",
        arguments: {
          noteId: note.id,
          taskText: "Nonexistent task",
          status: "done",
        },
      });

      expect(result.isError).toBe(true);
      expect(getToolText(result)).toContain("No task found");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("mark_as_task", () => {
    it("adds task metadata to note", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "Some task description",
      });

      const result = await client.callTool({
        name: "mark_as_task",
        arguments: {
          noteId: note.id,
          status: "in_progress",
          acceptanceCriteria: JSON.stringify(["Tests pass", "No regressions"]),
        },
      });
      const parsed = parseToolResult(result) as { noteId: string; status: string };
      expect(parsed.status).toBe("in_progress");

      const updated = await loadNote(tmpDir, note.id);
      expect(updated!.taskMetadata).toBeDefined();
      expect(updated!.taskMetadata!.status).toBe("in_progress");
      expect(updated!.taskMetadata!.acceptanceCriteria).toEqual([
        "Tests pass",
        "No regressions",
      ]);

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("update_note_task_status", () => {
    it("updates existing task metadata status", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        taskMetadata: { status: "not_started" },
      });

      const result = await client.callTool({
        name: "update_note_task_status",
        arguments: { noteId: note.id, status: "in_progress" },
      });
      const parsed = parseToolResult(result) as { status: string };
      expect(parsed.status).toBe("in_progress");

      const updated = await loadNote(tmpDir, note.id);
      expect(updated!.taskMetadata!.status).toBe("in_progress");

      await client.close();
      await server.mcpServer.close();
    });

    it("creates task metadata if none exists", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "No metadata yet",
      });

      await client.callTool({
        name: "update_note_task_status",
        arguments: { noteId: note.id, status: "complete" },
      });

      const updated = await loadNote(tmpDir, note.id);
      expect(updated!.taskMetadata).toBeDefined();
      expect(updated!.taskMetadata!.status).toBe("complete");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("get_my_task", () => {
    it("returns note with task metadata", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        title: "My Task",
        content: "Task content here",
        tags: ["task"],
        taskMetadata: {
          status: "in_progress",
          acceptanceCriteria: ["Criterion 1"],
        },
      });

      const result = await client.callTool({
        name: "get_my_task",
        arguments: { taskNoteId: note.id },
      });
      const parsed = parseToolResult(result) as {
        id: string;
        title: string;
        content: string;
        taskMetadata: { status: string; acceptanceCriteria: string[] };
        tags: string[];
      };

      expect(parsed.id).toBe(note.id);
      expect(parsed.title).toBe("My Task");
      expect(parsed.content).toContain("1 | Task content here");
      expect(parsed.taskMetadata.status).toBe("in_progress");
      expect(parsed.taskMetadata.acceptanceCriteria).toEqual(["Criterion 1"]);
      expect(parsed.tags).toEqual(["task"]);

      await client.close();
      await server.mcpServer.close();
    });

    it("returns null taskMetadata when note has none", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        title: "Plain Note",
        content: "Not a task",
      });

      const result = await client.callTool({
        name: "get_my_task",
        arguments: { taskNoteId: note.id },
      });
      const parsed = parseToolResult(result) as { taskMetadata: unknown };

      expect(parsed.taskMetadata).toBeNull();

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("convert_task_blocks", () => {
    it("converts @@@task blocks to linked task notes", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: `## Plan\n\n@@@task\n# Build auth system\nImplement authentication\n\n## Scope\nLogin + logout\n@@@\n`,
      });

      const result = await client.callTool({
        name: "convert_task_blocks",
        arguments: { noteId: note.id },
      });
      const parsed = parseToolResult(result) as {
        noteId: string;
        convertedCount: number;
        createdNoteIds: string[];
      };

      expect(parsed.convertedCount).toBe(1);
      expect(parsed.createdNoteIds).toHaveLength(1);

      // Check parent note was updated with link
      const updated = await loadNote(tmpDir, note.id);
      expect(updated!.content).toContain(`[Build auth system](intent://local/task/${parsed.createdNoteIds[0]})`);
      expect(updated!.content).not.toContain("@@@task");

      // Check created task note
      const taskNote = await loadNote(tmpDir, parsed.createdNoteIds[0]);
      expect(taskNote!.title).toBe("Build auth system");
      expect(taskNote!.content).toContain("Implement authentication");
      expect(taskNote!.taskMetadata!.status).toBe("not_started");

      await client.close();
      await server.mcpServer.close();
    });

    it("handles multiple task blocks", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: `@@@task\n# First task\nDo first thing\n@@@\n\nSome text\n\n@@@task\n# Second task\nDo second thing\n@@@\n`,
      });

      const result = await client.callTool({
        name: "convert_task_blocks",
        arguments: { noteId: note.id },
      });
      const parsed = parseToolResult(result) as {
        convertedCount: number;
        createdNoteIds: string[];
      };

      expect(parsed.convertedCount).toBe(2);
      expect(parsed.createdNoteIds).toHaveLength(2);

      const updated = await loadNote(tmpDir, note.id);
      expect(updated!.content).toContain("- [ ] [First task]");
      expect(updated!.content).toContain("- [ ] [Second task]");
      expect(updated!.content).toContain("Some text");

      await client.close();
      await server.mcpServer.close();
    });

    it("extracts title from # heading", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: `@@@task\n# My Custom Title\nBody content\n@@@\n`,
      });

      const result = await client.callTool({
        name: "convert_task_blocks",
        arguments: { noteId: note.id },
      });
      const parsed = parseToolResult(result) as { createdNoteIds: string[] };

      const taskNote = await loadNote(tmpDir, parsed.createdNoteIds[0]);
      expect(taskNote!.title).toBe("My Custom Title");

      await client.close();
      await server.mcpServer.close();
    });

    it('uses "Untitled Task" when no heading', async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: `@@@task\nJust some content without a heading\n@@@\n`,
      });

      const result = await client.callTool({
        name: "convert_task_blocks",
        arguments: { noteId: note.id },
      });
      const parsed = parseToolResult(result) as { createdNoteIds: string[] };

      const taskNote = await loadNote(tmpDir, parsed.createdNoteIds[0]);
      expect(taskNote!.title).toBe("Untitled Task");

      const updated = await loadNote(tmpDir, note.id);
      expect(updated!.content).toContain("[Untitled Task]");

      await client.close();
      await server.mcpServer.close();
    });

    it("returns 0 when no task blocks found", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "Just plain text\nNo task blocks here",
      });

      const result = await client.callTool({
        name: "convert_task_blocks",
        arguments: { noteId: note.id },
      });
      const parsed = parseToolResult(result) as {
        convertedCount: number;
        createdNoteIds: string[];
      };

      expect(parsed.convertedCount).toBe(0);
      expect(parsed.createdNoteIds).toEqual([]);

      await client.close();
      await server.mcpServer.close();
    });

    it("also handles ```task blocks", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "## Plan\n\n```task\n# Fenced task\nThis uses fenced syntax\n```\n",
      });

      const result = await client.callTool({
        name: "convert_task_blocks",
        arguments: { noteId: note.id },
      });
      const parsed = parseToolResult(result) as {
        convertedCount: number;
        createdNoteIds: string[];
      };

      expect(parsed.convertedCount).toBe(1);

      const taskNote = await loadNote(tmpDir, parsed.createdNoteIds[0]);
      expect(taskNote!.title).toBe("Fenced task");
      expect(taskNote!.content).toContain("This uses fenced syntax");

      const updated = await loadNote(tmpDir, note.id);
      expect(updated!.content).not.toContain("```task");
      expect(updated!.content).toContain("[Fenced task]");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("create_prerequisite", () => {
    it("creates prerequisite and links to dependent", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const dependentNote = await createTestNote(tmpDir, {
        content: "Main task",
        taskMetadata: { status: "not_started" },
      });

      const result = await client.callTool({
        name: "create_prerequisite",
        arguments: {
          dependentNoteId: dependentNote.id,
          title: "Setup database",
          content: "Create tables and migrations",
        },
      });
      const parsed = parseToolResult(result) as {
        prerequisiteNoteId: string;
        dependentNoteId: string;
        title: string;
      };

      expect(parsed.title).toBe("Setup database");
      expect(parsed.dependentNoteId).toBe(dependentNote.id);

      // Check prerequisite note was created
      const prereq = await loadNote(tmpDir, parsed.prerequisiteNoteId);
      expect(prereq).not.toBeNull();
      expect(prereq!.title).toBe("Setup database");
      expect(prereq!.content).toBe("Create tables and migrations");
      expect(prereq!.taskMetadata!.status).toBe("not_started");

      await client.close();
      await server.mcpServer.close();
    });

    it("adds dependency to dependent note's taskMetadata", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const dependentNote = await createTestNote(tmpDir, {
        content: "Main task",
        taskMetadata: { status: "in_progress" },
      });

      const result = await client.callTool({
        name: "create_prerequisite",
        arguments: {
          dependentNoteId: dependentNote.id,
          title: "Prerequisite task",
        },
      });
      const parsed = parseToolResult(result) as { prerequisiteNoteId: string };

      const updated = await loadNote(tmpDir, dependentNote.id);
      expect(updated!.taskMetadata!.dependencies).toBeDefined();
      expect(updated!.taskMetadata!.dependencies).toHaveLength(1);
      expect(updated!.taskMetadata!.dependencies![0].prerequisiteNoteId).toBe(
        parsed.prerequisiteNoteId,
      );
      expect(updated!.taskMetadata!.dependencies![0].status).toBe("pending");

      await client.close();
      await server.mcpServer.close();
    });

    it("errors when dependent note not found", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "create_prerequisite",
        arguments: {
          dependentNoteId: "nonexistent-note",
          title: "Some prerequisite",
        },
      });

      expect(result.isError).toBe(true);
      expect(getToolText(result)).toContain("not found");

      await client.close();
      await server.mcpServer.close();
    });

    it("with custom status sets it on prerequisite", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const dependentNote = await createTestNote(tmpDir, {
        content: "Main task",
        taskMetadata: { status: "not_started" },
      });

      const result = await client.callTool({
        name: "create_prerequisite",
        arguments: {
          dependentNoteId: dependentNote.id,
          title: "Urgent prerequisite",
          status: "in_progress",
        },
      });
      const parsed = parseToolResult(result) as { prerequisiteNoteId: string };

      const prereq = await loadNote(tmpDir, parsed.prerequisiteNoteId);
      expect(prereq!.taskMetadata!.status).toBe("in_progress");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("assign_agent", () => {
    it("adds agent to task note", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        taskMetadata: { status: "not_started" },
      });

      const result = await client.callTool({
        name: "assign_agent",
        arguments: { noteId: note.id, agentId: "agent-123" },
      });
      const parsed = parseToolResult(result) as {
        noteId: string;
        agentId: string;
        assigned: boolean;
      };

      expect(parsed.assigned).toBe(true);
      expect(parsed.agentId).toBe("agent-123");

      const updated = await loadNote(tmpDir, note.id);
      expect(updated!.taskMetadata!.assignedAgents).toContain("agent-123");

      await client.close();
      await server.mcpServer.close();
    });

    it("deduplicates agent IDs", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        taskMetadata: {
          status: "not_started",
          assignedAgents: ["agent-123"],
        },
      });

      await client.callTool({
        name: "assign_agent",
        arguments: { noteId: note.id, agentId: "agent-123" },
      });

      const updated = await loadNote(tmpDir, note.id);
      expect(updated!.taskMetadata!.assignedAgents).toEqual(["agent-123"]);

      await client.close();
      await server.mcpServer.close();
    });

    it("initializes taskMetadata if missing", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "Plain note without metadata",
      });

      await client.callTool({
        name: "assign_agent",
        arguments: { noteId: note.id, agentId: "agent-456" },
      });

      const updated = await loadNote(tmpDir, note.id);
      expect(updated!.taskMetadata).toBeDefined();
      expect(updated!.taskMetadata!.status).toBe("not_started");
      expect(updated!.taskMetadata!.assignedAgents).toEqual(["agent-456"]);

      await client.close();
      await server.mcpServer.close();
    });

    it("errors when note not found", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "assign_agent",
        arguments: { noteId: "nonexistent", agentId: "agent-789" },
      });

      expect(result.isError).toBe(true);
      expect(getToolText(result)).toContain("not found");

      await client.close();
      await server.mcpServer.close();
    });
  });
});
