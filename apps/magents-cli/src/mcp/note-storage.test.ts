import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createNote,
  deleteNote,
  getNotesDir,
  getOrCreateSpecNote,
  listNotes,
  loadNote,
  saveNote,
  type Note,
} from "./note-storage";

describe("note-storage", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "magents-notes-test-")));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("createNote", () => {
    it("creates a note file on disk", async () => {
      const note = await createNote(tmpDir, "My Note", "Hello world", ["tag1"]);

      expect(note.id).toBeDefined();
      expect(note.title).toBe("My Note");
      expect(note.content).toBe("Hello world");
      expect(note.tags).toEqual(["tag1"]);
      expect(note.createdAt).toBeDefined();
      expect(note.updatedAt).toBeDefined();

      const file = Bun.file(join(getNotesDir(tmpDir), `${note.id}.json`));
      expect(await file.exists()).toBe(true);
    });
  });

  describe("loadNote", () => {
    it("reads a note back from disk", async () => {
      const created = await createNote(tmpDir, "Load Test", "content here");
      const loaded = await loadNote(tmpDir, created.id);

      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(created.id);
      expect(loaded!.title).toBe("Load Test");
      expect(loaded!.content).toBe("content here");
    });

    it("returns null for nonexistent note", async () => {
      const loaded = await loadNote(tmpDir, "does-not-exist");
      expect(loaded).toBeNull();
    });
  });

  describe("listNotes", () => {
    it("returns all notes sorted by updatedAt desc", async () => {
      const note1 = await createNote(tmpDir, "First", "a");
      // Ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));
      const note2 = await createNote(tmpDir, "Second", "b");

      const notes = await listNotes(tmpDir);
      expect(notes).toHaveLength(2);
      // Most recently updated first
      expect(notes[0].id).toBe(note2.id);
      expect(notes[1].id).toBe(note1.id);
    });

    it("returns empty array when no notes exist", async () => {
      const notes = await listNotes(tmpDir);
      expect(notes).toEqual([]);
    });
  });

  describe("deleteNote", () => {
    it("removes the note file", async () => {
      const note = await createNote(tmpDir, "Delete Me", "bye");
      await deleteNote(tmpDir, note.id);

      const loaded = await loadNote(tmpDir, note.id);
      expect(loaded).toBeNull();
    });
  });

  describe("saveNote", () => {
    it("updates content and updatedAt", async () => {
      const note = await createNote(tmpDir, "Update Me", "original");
      const originalUpdatedAt = note.updatedAt;

      await new Promise((r) => setTimeout(r, 10));

      note.content = "modified";
      note.updatedAt = new Date().toISOString();
      await saveNote(tmpDir, note);

      const loaded = await loadNote(tmpDir, note.id);
      expect(loaded!.content).toBe("modified");
      expect(loaded!.updatedAt).not.toBe(originalUpdatedAt);
    });
  });

  describe("getOrCreateSpecNote", () => {
    it("creates spec note if missing", async () => {
      const spec = await getOrCreateSpecNote(tmpDir);

      expect(spec.id).toBe("spec");
      expect(spec.title).toBe("Spec");
      expect(spec.content).toBe("");

      // Verify it's on disk
      const loaded = await loadNote(tmpDir, "spec");
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe("spec");
    });

    it("returns existing spec note if present", async () => {
      // Create spec with custom content
      const now = new Date().toISOString();
      const existing: Note = {
        id: "spec",
        title: "Spec",
        content: "existing content",
        tags: ["important"],
        createdAt: now,
        updatedAt: now,
      };
      await saveNote(tmpDir, existing);

      const spec = await getOrCreateSpecNote(tmpDir);
      expect(spec.content).toBe("existing content");
      expect(spec.tags).toEqual(["important"]);
    });
  });
});
