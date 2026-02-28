import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./types.js";
import { loadNote } from "./note-storage.js";
import {
  addComment,
  deleteComment,
  loadComments,
  type Comment,
} from "./comment-storage.js";

interface ThreadSummary {
  threadId: string;
  noteId: string;
  targetedText: string | undefined;
  status: "open" | "resolved" | "pending";
  createdAt: string;
  lastActivity: string;
  latestCommentAuthor: string;
  latestCommentAuthorType: string;
  commentCount: number;
  comments?: Comment[];
}

function buildThreadSummary(
  threadId: string,
  comments: Comment[],
  includeComments?: boolean,
): ThreadSummary {
  const sorted = [...comments].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const root = sorted[0];
  const latest = sorted[sorted.length - 1];

  // Thread status: open if any comment is open, resolved if all resolved, else pending
  let status: "open" | "resolved" | "pending";
  if (sorted.some((c) => c.status === "open")) {
    status = "open";
  } else if (sorted.every((c) => c.status === "resolved")) {
    status = "resolved";
  } else {
    status = "pending";
  }

  const summary: ThreadSummary = {
    threadId,
    noteId: root.noteId,
    targetedText: root.section,
    status,
    createdAt: root.createdAt,
    lastActivity: latest.createdAt,
    latestCommentAuthor: latest.author,
    latestCommentAuthorType: latest.authorType,
    commentCount: sorted.length,
  };

  if (includeComments) {
    summary.comments = sorted;
  }

  return summary;
}

function findSuggestions(noteContent: string, searchContext: string): string[] {
  const words = searchContext.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines = noteContent.split("\n");
  const suggestions: string[] = [];
  const threshold = Math.ceil(words.length * 0.5);

  for (const line of lines) {
    const matchCount = words.filter((w) => line.includes(w)).length;
    if (matchCount >= threshold && line.trim().length > 0) {
      suggestions.push(line.trim());
    }
  }

  return suggestions.slice(0, 3);
}

function registerAddNoteComment(server: McpServer, context: ToolContext): void {
  server.tool(
    "add_note_comment",
    "Add a comment anchored to specific text in a note.",
    {
      noteId: z.string().describe("The ID of the note"),
      comment: z.string().describe("The comment text"),
      searchContext: z
        .string()
        .describe("A unique phrase from the note to anchor the comment to"),
      commentTarget: z
        .string()
        .describe("The specific text within searchContext to anchor to"),
      author: z.string().optional().describe("Author name (default: Agent)"),
      type: z
        .string()
        .optional()
        .describe("Comment type: comment, suggestion, question, change-request"),
      parentId: z.string().optional().describe("Parent comment ID for replies"),
      threadId: z.string().optional().describe("Thread ID to group comments"),
    },
    async ({
      noteId,
      comment: commentText,
      searchContext,
      commentTarget,
      author,
      type,
      parentId,
      threadId,
    }) => {
      const note = await loadNote(context.workspacePath, noteId);
      if (!note) {
        return {
          content: [
            { type: "text", text: `Error: Note "${noteId}" not found.` },
          ],
          isError: true,
        };
      }

      // Find searchContext in note content (case-sensitive, exact match)
      const contextIndex = note.content.indexOf(searchContext);
      if (contextIndex === -1) {
        const suggestions = findSuggestions(note.content, searchContext);
        const suggestionsText =
          suggestions.length > 0
            ? `\n\nSimilar lines found:\n${suggestions.map((s) => `  - "${s}"`).join("\n")}`
            : "";
        return {
          content: [
            {
              type: "text",
              text: `Error: CONTEXT_NOT_FOUND — The searchContext was not found in the note content. Make sure you copy the text exactly (case-sensitive).${suggestionsText}`,
            },
          ],
          isError: true,
        };
      }

      // Check for multiple matches of searchContext
      const secondMatch = note.content.indexOf(searchContext, contextIndex + 1);
      if (secondMatch !== -1) {
        let count = 2;
        let pos = secondMatch;
        while (true) {
          pos = note.content.indexOf(searchContext, pos + 1);
          if (pos === -1) break;
          count++;
        }
        return {
          content: [
            {
              type: "text",
              text: `Error: CONTEXT_AMBIGUOUS — The searchContext was found ${count} times. Provide more surrounding text to make it unique.`,
            },
          ],
          isError: true,
        };
      }

      // Find commentTarget within searchContext
      const targetIndex = searchContext.indexOf(commentTarget);
      if (targetIndex === -1) {
        return {
          content: [
            {
              type: "text",
              text: `Error: TARGET_NOT_IN_CONTEXT — The commentTarget "${commentTarget}" was not found within the searchContext. The target must be a substring of the context.`,
            },
          ],
          isError: true,
        };
      }

      // Check for multiple occurrences of commentTarget in searchContext
      const secondTargetMatch = searchContext.indexOf(
        commentTarget,
        targetIndex + 1,
      );
      if (secondTargetMatch !== -1) {
        return {
          content: [
            {
              type: "text",
              text: `Error: TARGET_AMBIGUOUS_IN_CONTEXT — The commentTarget appears multiple times within the searchContext. Use a more specific target.`,
            },
          ],
          isError: true,
        };
      }

      // Determine threadId
      let resolvedThreadId = threadId;
      if (!resolvedThreadId && parentId) {
        // Look up parent's threadId
        const existingComments = await loadComments(
          context.workspacePath,
          noteId,
        );
        const parent = existingComments.find((c) => c.id === parentId);
        if (parent) {
          resolvedThreadId = parent.threadId;
        }
      }

      const commentType = (type ?? "comment") as Comment["type"];
      const newComment = await addComment(context.workspacePath, {
        noteId,
        content: commentText,
        author: author ?? "Agent",
        authorType: "agent",
        type: commentType,
        status: "open",
        threadId: resolvedThreadId ?? "", // placeholder, will be set to own id
        parentId,
        section: commentTarget,
      });

      // If no threadId was resolved, use the comment's own id
      if (!resolvedThreadId) {
        const comments = await loadComments(context.workspacePath, noteId);
        const idx = comments.findIndex((c) => c.id === newComment.id);
        if (idx !== -1) {
          comments[idx].threadId = newComment.id;
          newComment.threadId = newComment.id;
          const { saveComments } = await import("./comment-storage.js");
          await saveComments(context.workspacePath, noteId, comments);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              commentId: newComment.id,
              anchored: true,
              location: { anchoredText: commentTarget },
            }),
          },
        ],
      };
    },
  );
}

function registerListNoteComments(
  server: McpServer,
  context: ToolContext,
): void {
  server.tool(
    "list_note_comments",
    "List comment threads on a note with optional filtering.",
    {
      noteId: z.string().describe("The ID of the note"),
      includeComments: z
        .boolean()
        .optional()
        .describe("Include full comment objects in each thread"),
      since: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp — only threads with activity after this"),
      authorType: z
        .string()
        .optional()
        .describe(
          "Filter threads where the latest comment is from this author type",
        ),
      status: z
        .string()
        .optional()
        .describe("Filter threads by status: open, resolved, pending"),
    },
    async ({ noteId, includeComments, since, authorType, status }) => {
      const comments = await loadComments(context.workspacePath, noteId);

      // Group by threadId
      const threadMap = new Map<string, Comment[]>();
      for (const c of comments) {
        const existing = threadMap.get(c.threadId) ?? [];
        existing.push(c);
        threadMap.set(c.threadId, existing);
      }

      let threads: ThreadSummary[] = [];
      for (const [tid, threadComments] of threadMap) {
        threads.push(
          buildThreadSummary(tid, threadComments, includeComments ?? false),
        );
      }

      // Apply filters
      if (since) {
        const sinceTime = new Date(since).getTime();
        threads = threads.filter(
          (t) => new Date(t.lastActivity).getTime() > sinceTime,
        );
      }
      if (authorType) {
        threads = threads.filter(
          (t) => t.latestCommentAuthorType === authorType,
        );
      }
      if (status) {
        threads = threads.filter((t) => t.status === status);
      }

      // Sort by lastActivity descending
      threads.sort(
        (a, b) =>
          new Date(b.lastActivity).getTime() -
          new Date(a.lastActivity).getTime(),
      );

      const totalComments = threads.reduce(
        (sum, t) => sum + t.commentCount,
        0,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              threads,
              totalThreads: threads.length,
              totalComments,
            }),
          },
        ],
      };
    },
  );
}

function registerGetCommentThread(
  server: McpServer,
  context: ToolContext,
): void {
  server.tool(
    "get_comment_thread",
    "Get a complete comment thread with all replies.",
    {
      noteId: z.string().describe("The ID of the note"),
      threadId: z.string().optional().describe("The thread ID to retrieve"),
      commentId: z
        .string()
        .optional()
        .describe("Get the thread containing this comment"),
    },
    async ({ noteId, threadId, commentId }) => {
      if (!threadId && !commentId) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Either threadId or commentId must be provided.",
            },
          ],
          isError: true,
        };
      }

      const comments = await loadComments(context.workspacePath, noteId);

      let resolvedThreadId = threadId;
      if (!resolvedThreadId && commentId) {
        const target = comments.find((c) => c.id === commentId);
        if (!target) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Comment "${commentId}" not found.`,
              },
            ],
            isError: true,
          };
        }
        resolvedThreadId = target.threadId;
      }

      const threadComments = comments
        .filter((c) => c.threadId === resolvedThreadId)
        .sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );

      if (threadComments.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Thread "${resolvedThreadId}" not found.`,
            },
          ],
          isError: true,
        };
      }

      const rootComment = threadComments[0];
      const replies = threadComments.slice(1);

      // Thread status
      let threadStatus: "open" | "resolved" | "pending";
      if (threadComments.some((c) => c.status === "open")) {
        threadStatus = "open";
      } else if (threadComments.every((c) => c.status === "resolved")) {
        threadStatus = "resolved";
      } else {
        threadStatus = "pending";
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              threadId: resolvedThreadId,
              noteId,
              rootComment,
              replies,
              totalComments: threadComments.length,
              status: threadStatus,
            }),
          },
        ],
      };
    },
  );
}

function registerRespondToCommentThread(
  server: McpServer,
  context: ToolContext,
): void {
  server.tool(
    "respond_to_comment_thread",
    "Add a reply to an existing comment thread.",
    {
      noteId: z.string().describe("The ID of the note"),
      threadId: z.string().optional().describe("The thread ID to respond to"),
      commentId: z
        .string()
        .optional()
        .describe("Respond to the thread containing this comment"),
      comment: z.string().describe("Your response text"),
      author: z.string().optional().describe("Author name (default: Agent)"),
      type: z
        .string()
        .optional()
        .describe("Comment type: comment, suggestion, question, change-request"),
    },
    async ({ noteId, threadId, commentId, comment: commentText, author, type }) => {
      if (!threadId && !commentId) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Either threadId or commentId must be provided.",
            },
          ],
          isError: true,
        };
      }

      const comments = await loadComments(context.workspacePath, noteId);

      let resolvedThreadId = threadId;
      let parentComment: Comment | undefined;

      if (commentId) {
        parentComment = comments.find((c) => c.id === commentId);
        if (!parentComment) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Comment "${commentId}" not found.`,
              },
            ],
            isError: true,
          };
        }
        resolvedThreadId = parentComment.threadId;
      }

      if (!resolvedThreadId) {
        return {
          content: [
            { type: "text", text: "Error: Could not resolve thread." },
          ],
          isError: true,
        };
      }

      // Get thread comments to find parent and section
      const threadComments = comments.filter(
        (c) => c.threadId === resolvedThreadId,
      );
      if (threadComments.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Thread "${resolvedThreadId}" not found.`,
            },
          ],
          isError: true,
        };
      }

      // Use most recent comment as parent if no specific commentId
      if (!parentComment) {
        const sorted = [...threadComments].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        parentComment = sorted[0];
      }

      const commentType = (type ?? "comment") as Comment["type"];
      const newComment = await addComment(context.workspacePath, {
        noteId,
        content: commentText,
        author: author ?? "Agent",
        authorType: "agent",
        type: commentType,
        status: "open",
        threadId: resolvedThreadId,
        parentId: parentComment.id,
        section: parentComment.section,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              commentId: newComment.id,
              threadId: resolvedThreadId,
              parentId: parentComment.id,
            }),
          },
        ],
      };
    },
  );
}

function registerDeleteNoteComment(
  server: McpServer,
  context: ToolContext,
): void {
  server.tool(
    "delete_note_comment",
    "Delete a specific comment from a note.",
    {
      noteId: z.string().describe("The ID of the note"),
      commentId: z.string().describe("The ID of the comment to delete"),
    },
    async ({ noteId, commentId }) => {
      await deleteComment(context.workspacePath, noteId, commentId);
      return {
        content: [
          { type: "text", text: JSON.stringify({ deleted: true }) },
        ],
      };
    },
  );
}

export function registerCommentTools(
  server: McpServer,
  context: ToolContext,
): void {
  registerAddNoteComment(server, context);
  registerListNoteComments(server, context);
  registerGetCommentThread(server, context);
  registerRespondToCommentThread(server, context);
  registerDeleteNoteComment(server, context);
}
