import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  addComment,
  deleteComment,
  getCommentsByThread,
  loadComments,
  type Comment,
} from "./comment-storage";

describe("comment-storage", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "magents-cs-test-")));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("addComment", () => {
    it("creates and stores comment", async () => {
      const comment = await addComment(tmpDir, {
        noteId: "note-1",
        content: "This looks good",
        author: "Agent",
        authorType: "agent",
        type: "comment",
        status: "open",
        threadId: "thread-placeholder",
        section: "some text",
      });

      expect(comment.id).toBeDefined();
      expect(comment.content).toBe("This looks good");
      expect(comment.createdAt).toBeDefined();
      expect(comment.updatedAt).toBeDefined();

      // Verify file was written
      const file = Bun.file(
        join(tmpDir, ".workspace", "comments", "note-1.json"),
      );
      expect(await file.exists()).toBe(true);
      const data = JSON.parse(await file.text()) as Comment[];
      expect(data).toHaveLength(1);
      expect(data[0].content).toBe("This looks good");
    });
  });

  describe("loadComments", () => {
    it("returns empty array for nonexistent note", async () => {
      const result = await loadComments(tmpDir, "nonexistent");
      expect(result).toEqual([]);
    });
  });

  describe("deleteComment", () => {
    it("removes specific comment", async () => {
      const c1 = await addComment(tmpDir, {
        noteId: "note-1",
        content: "Comment 1",
        author: "Agent",
        authorType: "agent",
        type: "comment",
        status: "open",
        threadId: "t1",
      });
      await addComment(tmpDir, {
        noteId: "note-1",
        content: "Comment 2",
        author: "Agent",
        authorType: "agent",
        type: "comment",
        status: "open",
        threadId: "t2",
      });

      await deleteComment(tmpDir, "note-1", c1.id);

      const remaining = await loadComments(tmpDir, "note-1");
      expect(remaining).toHaveLength(1);
      expect(remaining[0].content).toBe("Comment 2");
    });
  });

  describe("getCommentsByThread", () => {
    it("filters correctly", async () => {
      await addComment(tmpDir, {
        noteId: "note-1",
        content: "Thread A comment",
        author: "Agent",
        authorType: "agent",
        type: "comment",
        status: "open",
        threadId: "thread-a",
      });
      await addComment(tmpDir, {
        noteId: "note-1",
        content: "Thread B comment",
        author: "Agent",
        authorType: "agent",
        type: "comment",
        status: "open",
        threadId: "thread-b",
      });
      await addComment(tmpDir, {
        noteId: "note-1",
        content: "Thread A reply",
        author: "User",
        authorType: "user",
        type: "comment",
        status: "open",
        threadId: "thread-a",
      });

      const threadA = await getCommentsByThread(tmpDir, "note-1", "thread-a");
      expect(threadA).toHaveLength(2);
      expect(threadA[0].content).toBe("Thread A comment");
      expect(threadA[1].content).toBe("Thread A reply");

      const threadB = await getCommentsByThread(tmpDir, "note-1", "thread-b");
      expect(threadB).toHaveLength(1);
    });
  });
});
