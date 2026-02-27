import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export interface Comment {
  id: string;
  noteId: string;
  content: string;
  author: string;
  authorType: "user" | "agent";
  type: "comment" | "suggestion" | "question" | "change-request";
  status: "open" | "resolved" | "pending";
  threadId: string;
  parentId?: string;
  section?: string;
  createdAt: string;
  updatedAt: string;
}

export function getCommentsDir(workspacePath: string): string {
  return join(workspacePath, ".workspace", "comments");
}

export async function ensureCommentsDir(workspacePath: string): Promise<void> {
  await mkdir(getCommentsDir(workspacePath), { recursive: true });
}

export async function loadComments(
  workspacePath: string,
  noteId: string,
): Promise<Comment[]> {
  const filePath = join(getCommentsDir(workspacePath), `${noteId}.json`);
  const file = Bun.file(filePath);
  if (!(await file.exists())) return [];
  return JSON.parse(await file.text()) as Comment[];
}

export async function saveComments(
  workspacePath: string,
  noteId: string,
  comments: Comment[],
): Promise<void> {
  await ensureCommentsDir(workspacePath);
  const filePath = join(getCommentsDir(workspacePath), `${noteId}.json`);
  await Bun.write(filePath, JSON.stringify(comments, null, 2) + "\n");
}

export async function addComment(
  workspacePath: string,
  comment: Omit<Comment, "id" | "createdAt" | "updatedAt">,
): Promise<Comment> {
  const now = new Date().toISOString();
  const fullComment: Comment = {
    ...comment,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  const existing = await loadComments(workspacePath, comment.noteId);
  existing.push(fullComment);
  await saveComments(workspacePath, comment.noteId, existing);
  return fullComment;
}

export async function deleteComment(
  workspacePath: string,
  noteId: string,
  commentId: string,
): Promise<void> {
  const comments = await loadComments(workspacePath, noteId);
  const filtered = comments.filter((c) => c.id !== commentId);
  await saveComments(workspacePath, noteId, filtered);
}

export async function getCommentsByThread(
  workspacePath: string,
  noteId: string,
  threadId: string,
): Promise<Comment[]> {
  const comments = await loadComments(workspacePath, noteId);
  return comments.filter((c) => c.threadId === threadId);
}
