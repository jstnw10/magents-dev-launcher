import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MagentsMcpServer } from "./server";
import { registerNoteTools } from "./note-tools";
import { registerCommentTools } from "./comment-tools";
import { saveNote, type Note } from "./note-storage";
import { addComment } from "./comment-storage";

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
  server.registerTools([registerNoteTools, registerCommentTools]);

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
    id: overrides.id ?? Bun.randomUUIDv7(),
    title: overrides.title ?? "Test Note",
    content:
      overrides.content ??
      "## Features\n\nThis section describes the main features of the app.\n\n## Getting Started\n\nFollow these steps to get started.",
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
  await saveNote(workspacePath, note);
  return note;
}

describe("comment-tools", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realpath(
      await mkdtemp(join(tmpdir(), "magents-ct-test-")),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("add_note_comment", () => {
    it("anchors to found text", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir);

      const result = await client.callTool({
        name: "add_note_comment",
        arguments: {
          noteId: note.id,
          comment: "This is a great section!",
          searchContext: "This section describes the main features",
          commentTarget: "main features",
        },
      });

      const parsed = parseToolResult(result) as {
        commentId: string;
        anchored: boolean;
        location: { anchoredText: string };
      };

      expect(parsed.commentId).toBeDefined();
      expect(parsed.anchored).toBe(true);
      expect(parsed.location.anchoredText).toBe("main features");

      await client.close();
      await server.mcpServer.close();
    });

    it("errors on context not found", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir);

      const result = await client.callTool({
        name: "add_note_comment",
        arguments: {
          noteId: note.id,
          comment: "A comment",
          searchContext: "nonexistent text that is not in the note",
          commentTarget: "nonexistent",
        },
      });

      expect(result.isError).toBe(true);
      const text = getToolText(result);
      expect(text).toContain("CONTEXT_NOT_FOUND");

      await client.close();
      await server.mcpServer.close();
    });

    it("errors on ambiguous context", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir, {
        content: "hello world\nhello world\nhello world",
      });

      const result = await client.callTool({
        name: "add_note_comment",
        arguments: {
          noteId: note.id,
          comment: "A comment",
          searchContext: "hello world",
          commentTarget: "hello",
        },
      });

      expect(result.isError).toBe(true);
      const text = getToolText(result);
      expect(text).toContain("CONTEXT_AMBIGUOUS");

      await client.close();
      await server.mcpServer.close();
    });

    it("errors on target not in context", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir);

      const result = await client.callTool({
        name: "add_note_comment",
        arguments: {
          noteId: note.id,
          comment: "A comment",
          searchContext: "This section describes the main features",
          commentTarget: "something else entirely",
        },
      });

      expect(result.isError).toBe(true);
      const text = getToolText(result);
      expect(text).toContain("TARGET_NOT_IN_CONTEXT");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("list_note_comments", () => {
    it("returns grouped threads", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir);

      // Add two comments in different threads
      const c1 = await addComment(tmpDir, {
        noteId: note.id,
        content: "First thread",
        author: "Agent",
        authorType: "agent",
        type: "comment",
        status: "open",
        threadId: "thread-1",
        section: "main features",
      });
      // Self-reference threadId
      const { saveComments, loadComments } = await import(
        "./comment-storage"
      );
      let comments = await loadComments(tmpDir, note.id);
      comments[0].threadId = c1.id;
      await saveComments(tmpDir, note.id, comments);

      const c2 = await addComment(tmpDir, {
        noteId: note.id,
        content: "Second thread",
        author: "User",
        authorType: "user",
        type: "question",
        status: "open",
        threadId: "temp",
        section: "Getting Started",
      });
      comments = await loadComments(tmpDir, note.id);
      comments[1].threadId = c2.id;
      await saveComments(tmpDir, note.id, comments);

      const result = await client.callTool({
        name: "list_note_comments",
        arguments: { noteId: note.id },
      });

      const parsed = parseToolResult(result) as {
        threads: Array<{
          threadId: string;
          targetedText: string;
          commentCount: number;
        }>;
        totalThreads: number;
        totalComments: number;
      };

      expect(parsed.totalThreads).toBe(2);
      expect(parsed.totalComments).toBe(2);
      expect(parsed.threads).toHaveLength(2);

      await client.close();
      await server.mcpServer.close();
    });

    it("filters by status", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir);

      const c1 = await addComment(tmpDir, {
        noteId: note.id,
        content: "Open comment",
        author: "Agent",
        authorType: "agent",
        type: "comment",
        status: "open",
        threadId: "temp",
        section: "features",
      });
      const { saveComments, loadComments } = await import(
        "./comment-storage"
      );
      let comments = await loadComments(tmpDir, note.id);
      comments[0].threadId = c1.id;
      await saveComments(tmpDir, note.id, comments);

      const c2 = await addComment(tmpDir, {
        noteId: note.id,
        content: "Resolved comment",
        author: "Agent",
        authorType: "agent",
        type: "comment",
        status: "resolved",
        threadId: "temp",
        section: "started",
      });
      comments = await loadComments(tmpDir, note.id);
      comments[1].threadId = c2.id;
      await saveComments(tmpDir, note.id, comments);

      const result = await client.callTool({
        name: "list_note_comments",
        arguments: { noteId: note.id, status: "open" },
      });

      const parsed = parseToolResult(result) as {
        threads: Array<{ status: string }>;
        totalThreads: number;
      };

      expect(parsed.totalThreads).toBe(1);
      expect(parsed.threads[0].status).toBe("open");

      await client.close();
      await server.mcpServer.close();
    });

    it("filters by authorType", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir);

      const c1 = await addComment(tmpDir, {
        noteId: note.id,
        content: "Agent comment",
        author: "Agent",
        authorType: "agent",
        type: "comment",
        status: "open",
        threadId: "temp",
        section: "features",
      });
      const { saveComments, loadComments } = await import(
        "./comment-storage"
      );
      let comments = await loadComments(tmpDir, note.id);
      comments[0].threadId = c1.id;
      await saveComments(tmpDir, note.id, comments);

      const c2 = await addComment(tmpDir, {
        noteId: note.id,
        content: "User comment",
        author: "User",
        authorType: "user",
        type: "comment",
        status: "open",
        threadId: "temp",
        section: "started",
      });
      comments = await loadComments(tmpDir, note.id);
      comments[1].threadId = c2.id;
      await saveComments(tmpDir, note.id, comments);

      const result = await client.callTool({
        name: "list_note_comments",
        arguments: { noteId: note.id, authorType: "user" },
      });

      const parsed = parseToolResult(result) as {
        threads: Array<{ latestCommentAuthorType: string }>;
        totalThreads: number;
      };

      expect(parsed.totalThreads).toBe(1);
      expect(parsed.threads[0].latestCommentAuthorType).toBe("user");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("get_comment_thread", () => {
    it("returns full thread", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir);

      // Create a thread with root + reply
      const root = await addComment(tmpDir, {
        noteId: note.id,
        content: "Root comment",
        author: "Agent",
        authorType: "agent",
        type: "comment",
        status: "open",
        threadId: "temp",
        section: "features",
      });
      const { saveComments, loadComments } = await import(
        "./comment-storage"
      );
      let comments = await loadComments(tmpDir, note.id);
      comments[0].threadId = root.id;
      await saveComments(tmpDir, note.id, comments);

      await addComment(tmpDir, {
        noteId: note.id,
        content: "Reply comment",
        author: "User",
        authorType: "user",
        type: "comment",
        status: "open",
        threadId: root.id,
        parentId: root.id,
        section: "features",
      });

      const result = await client.callTool({
        name: "get_comment_thread",
        arguments: { noteId: note.id, threadId: root.id },
      });

      const parsed = parseToolResult(result) as {
        threadId: string;
        rootComment: { content: string };
        replies: Array<{ content: string }>;
        totalComments: number;
        status: string;
      };

      expect(parsed.threadId).toBe(root.id);
      expect(parsed.rootComment.content).toBe("Root comment");
      expect(parsed.replies).toHaveLength(1);
      expect(parsed.replies[0].content).toBe("Reply comment");
      expect(parsed.totalComments).toBe(2);
      expect(parsed.status).toBe("open");

      await client.close();
      await server.mcpServer.close();
    });

    it("finds thread by commentId", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir);

      const root = await addComment(tmpDir, {
        noteId: note.id,
        content: "Root",
        author: "Agent",
        authorType: "agent",
        type: "comment",
        status: "open",
        threadId: "temp",
        section: "features",
      });
      const { saveComments, loadComments } = await import(
        "./comment-storage"
      );
      let comments = await loadComments(tmpDir, note.id);
      comments[0].threadId = root.id;
      await saveComments(tmpDir, note.id, comments);

      const reply = await addComment(tmpDir, {
        noteId: note.id,
        content: "Reply",
        author: "User",
        authorType: "user",
        type: "comment",
        status: "open",
        threadId: root.id,
        parentId: root.id,
        section: "features",
      });

      // Find thread by the reply's commentId
      const result = await client.callTool({
        name: "get_comment_thread",
        arguments: { noteId: note.id, commentId: reply.id },
      });

      const parsed = parseToolResult(result) as {
        threadId: string;
        totalComments: number;
      };

      expect(parsed.threadId).toBe(root.id);
      expect(parsed.totalComments).toBe(2);

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("respond_to_comment_thread", () => {
    it("adds reply correctly", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir);

      // Create root comment
      const root = await addComment(tmpDir, {
        noteId: note.id,
        content: "Root comment",
        author: "Agent",
        authorType: "agent",
        type: "comment",
        status: "open",
        threadId: "temp",
        section: "features",
      });
      const { saveComments, loadComments } = await import(
        "./comment-storage"
      );
      let comments = await loadComments(tmpDir, note.id);
      comments[0].threadId = root.id;
      await saveComments(tmpDir, note.id, comments);

      const result = await client.callTool({
        name: "respond_to_comment_thread",
        arguments: {
          noteId: note.id,
          threadId: root.id,
          comment: "This is a reply",
        },
      });

      const parsed = parseToolResult(result) as {
        commentId: string;
        threadId: string;
        parentId: string;
      };

      expect(parsed.commentId).toBeDefined();
      expect(parsed.threadId).toBe(root.id);
      expect(parsed.parentId).toBe(root.id);

      // Verify the reply was saved
      comments = await loadComments(tmpDir, note.id);
      expect(comments).toHaveLength(2);
      const reply = comments.find((c) => c.id === parsed.commentId);
      expect(reply).toBeDefined();
      expect(reply!.content).toBe("This is a reply");
      expect(reply!.section).toBe("features");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("delete_note_comment", () => {
    it("removes comment", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);
      const note = await createTestNote(tmpDir);

      const comment = await addComment(tmpDir, {
        noteId: note.id,
        content: "To be deleted",
        author: "Agent",
        authorType: "agent",
        type: "comment",
        status: "open",
        threadId: "temp",
        section: "features",
      });

      const result = await client.callTool({
        name: "delete_note_comment",
        arguments: { noteId: note.id, commentId: comment.id },
      });

      const parsed = parseToolResult(result) as { deleted: boolean };
      expect(parsed.deleted).toBe(true);

      // Verify comment was removed
      const { loadComments } = await import("./comment-storage");
      const remaining = await loadComments(tmpDir, note.id);
      expect(remaining).toHaveLength(0);

      await client.close();
      await server.mcpServer.close();
    });
  });
});
