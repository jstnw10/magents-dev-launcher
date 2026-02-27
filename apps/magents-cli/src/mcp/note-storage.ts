import { join } from "node:path";
import { mkdir, readdir, unlink } from "node:fs/promises";

export interface TaskMetadata {
  status: string;
  acceptanceCriteria?: string[];
  assignedAgents?: string[];
  dependencies?: Array<{ prerequisiteNoteId: string; status: string }>;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  taskMetadata?: TaskMetadata;
}

export function getNotesDir(workspacePath: string): string {
  return join(workspacePath, ".workspace", "notes");
}

export async function ensureNotesDir(workspacePath: string): Promise<void> {
  await mkdir(getNotesDir(workspacePath), { recursive: true });
}

export async function loadNote(
  workspacePath: string,
  id: string,
): Promise<Note | null> {
  const filePath = join(getNotesDir(workspacePath), `${id}.json`);
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  return JSON.parse(await file.text()) as Note;
}

export async function saveNote(
  workspacePath: string,
  note: Note,
): Promise<void> {
  await ensureNotesDir(workspacePath);
  const filePath = join(getNotesDir(workspacePath), `${note.id}.json`);
  await Bun.write(filePath, JSON.stringify(note, null, 2) + "\n");
}

export async function listNotes(workspacePath: string): Promise<Note[]> {
  const dir = getNotesDir(workspacePath);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const notes: Note[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = join(dir, entry);
    const file = Bun.file(filePath);
    const note = JSON.parse(await file.text()) as Note;
    notes.push(note);
  }

  notes.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return notes;
}

export async function deleteNote(
  workspacePath: string,
  id: string,
): Promise<void> {
  const filePath = join(getNotesDir(workspacePath), `${id}.json`);
  await unlink(filePath);
}

export async function createNote(
  workspacePath: string,
  title: string,
  content: string,
  tags?: string[],
): Promise<Note> {
  const now = new Date().toISOString();
  const note: Note = {
    id: crypto.randomUUID(),
    title,
    content,
    tags: tags ?? [],
    createdAt: now,
    updatedAt: now,
  };
  await saveNote(workspacePath, note);
  return note;
}

export async function getOrCreateSpecNote(
  workspacePath: string,
): Promise<Note> {
  const existing = await loadNote(workspacePath, "spec");
  if (existing) return existing;

  const now = new Date().toISOString();
  const spec: Note = {
    id: "spec",
    title: "Spec",
    content: "",
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
  await saveNote(workspacePath, spec);
  return spec;
}
