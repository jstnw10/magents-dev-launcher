import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./types.js";
import {
  createNote,
  deleteNote,
  getOrCreateSpecNote,
  listNotes,
  loadNote,
  saveNote,
} from "./note-storage.js";

function formatContentWithLineNumbers(content: string): string {
  const lines = content.split("\n");
  const maxLineNum = lines.length;
  const width = String(maxLineNum).length;
  return lines
    .map((line, i) => {
      const num = String(i + 1).padStart(width, " ");
      return `${num} | ${line}`;
    })
    .join("\n");
}

function registerCreateNote(server: McpServer, context: ToolContext): void {
  server.tool(
    "create_note",
    "Create a new note in the workspace.",
    {
      title: z.string().describe("The title of the note"),
      content: z.string().describe("The content of the note"),
      tags: z
        .string()
        .optional()
        .describe("Comma-separated tags for the note"),
    },
    async ({ title, content, tags }) => {
      const tagArray = tags
        ? tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;
      const note = await createNote(context.workspacePath, title, content, tagArray);
      return {
        content: [
          { type: "text", text: JSON.stringify({ id: note.id, title: note.title }) },
        ],
      };
    },
  );
}

function registerListNotes(server: McpServer, context: ToolContext): void {
  server.tool(
    "list_notes",
    "List all notes in the workspace.",
    {
      tag: z.string().optional().describe("Optional: filter by tag"),
    },
    async ({ tag }) => {
      let notes = await listNotes(context.workspacePath);
      if (tag) {
        notes = notes.filter((n) => n.tags.includes(tag));
      }
      const result = notes.map((n) => ({
        id: n.id,
        title: n.title,
        tags: n.tags,
        updatedAt: n.updatedAt,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );
}

function registerReadNote(server: McpServer, context: ToolContext): void {
  server.tool(
    "read_note",
    "Read the content of a specific note. Use noteId='spec' for the workspace specification.",
    {
      noteId: z.string().describe("The ID of the note to read"),
    },
    async ({ noteId }) => {
      let note;
      if (noteId === "spec") {
        note = await getOrCreateSpecNote(context.workspacePath);
      } else {
        note = await loadNote(context.workspacePath, noteId);
      }

      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Note "${noteId}" not found.` }],
          isError: true,
        };
      }

      const formatted = formatContentWithLineNumbers(note.content);
      return {
        content: [
          {
            type: "text",
            text: `Note: ${note.title}\n\n${formatted}`,
          },
        ],
      };
    },
  );
}

function registerDeleteNote(server: McpServer, context: ToolContext): void {
  server.tool(
    "delete_note",
    "Delete a note from the workspace.",
    {
      noteId: z.string().describe("The ID of the note to delete"),
    },
    async ({ noteId }) => {
      if (noteId === "spec") {
        return {
          content: [
            { type: "text", text: "Error: Cannot delete the spec note." },
          ],
          isError: true,
        };
      }

      const note = await loadNote(context.workspacePath, noteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Note "${noteId}" not found.` }],
          isError: true,
        };
      }

      await deleteNote(context.workspacePath, noteId);
      return {
        content: [
          { type: "text", text: JSON.stringify({ noteId, deleted: true }) },
        ],
      };
    },
  );
}

function registerSetNoteContent(server: McpServer, context: ToolContext): void {
  server.tool(
    "set_note_content",
    "Replace the entire content of a note.",
    {
      noteId: z.string().describe("The ID of the note to update"),
      content: z.string().describe("The new content"),
    },
    async ({ noteId, content }) => {
      const note = await loadNote(context.workspacePath, noteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Note "${noteId}" not found.` }],
          isError: true,
        };
      }

      note.content = content;
      note.updatedAt = new Date().toISOString();
      await saveNote(context.workspacePath, note);

      return {
        content: [
          { type: "text", text: JSON.stringify({ noteId, updated: true }) },
        ],
      };
    },
  );
}

function registerAddToNote(server: McpServer, context: ToolContext): void {
  server.tool(
    "add_to_note",
    "Add content to an existing note. Supports positioning: end, start, or after a specific heading.",
    {
      noteId: z.string().describe("The ID of the note to add to"),
      content: z.string().describe("The content to add"),
      heading: z
        .string()
        .optional()
        .describe("Optional section heading to add before the content"),
      position: z
        .string()
        .optional()
        .describe(
          'Where to add: "end" (default), "start", or "after:HEADING"',
        ),
    },
    async ({ noteId, content: newContent, heading, position }) => {
      const note = await loadNote(context.workspacePath, noteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Note "${noteId}" not found.` }],
          isError: true,
        };
      }

      const textToAdd = heading ? `${heading}\n${newContent}` : newContent;
      const pos = position ?? "end";

      if (pos === "start") {
        note.content = note.content
          ? `${textToAdd}\n${note.content}`
          : textToAdd;
      } else if (pos === "end") {
        note.content = note.content
          ? `${note.content}\n${textToAdd}`
          : textToAdd;
      } else if (pos.startsWith("after:")) {
        const targetHeading = pos.slice("after:".length);
        const lines = note.content.split("\n");
        const headingIndex = lines.findIndex((line) => line.trim() === targetHeading);

        if (headingIndex === -1) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Heading "${targetHeading}" not found in note.`,
              },
            ],
            isError: true,
          };
        }

        // Find the end of the section: next heading or end of content
        let insertIndex = headingIndex + 1;
        for (let i = headingIndex + 1; i < lines.length; i++) {
          if (/^#{1,6}\s/.test(lines[i])) {
            break;
          }
          insertIndex = i + 1;
        }

        lines.splice(insertIndex, 0, textToAdd);
        note.content = lines.join("\n");
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Error: Invalid position "${pos}". Use "end", "start", or "after:HEADING".`,
            },
          ],
          isError: true,
        };
      }

      note.updatedAt = new Date().toISOString();
      await saveNote(context.workspacePath, note);

      return {
        content: [
          { type: "text", text: JSON.stringify({ noteId, updated: true }) },
        ],
      };
    },
  );
}

function registerEditNote(server: McpServer, context: ToolContext): void {
  server.tool(
    "edit_note",
    "Surgically edit a note by replacing specific text (str_replace style).",
    {
      noteId: z.string().describe("The ID of the note to edit"),
      old_text: z.string().describe("The exact text to find and replace"),
      new_text: z.string().describe("The replacement text"),
    },
    async ({ noteId, old_text, new_text }) => {
      const note = await loadNote(context.workspacePath, noteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Note "${noteId}" not found.` }],
          isError: true,
        };
      }

      // Count occurrences
      let count = 0;
      let searchFrom = 0;
      while (true) {
        const idx = note.content.indexOf(old_text, searchFrom);
        if (idx === -1) break;
        count++;
        searchFrom = idx + old_text.length;
      }

      if (count === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: old_text not found in note content.",
            },
          ],
          isError: true,
        };
      }

      if (count > 1) {
        return {
          content: [
            {
              type: "text",
              text: `Error: old_text found ${count} times. It must be unique. Provide more context to make it unique.`,
            },
          ],
          isError: true,
        };
      }

      note.content = note.content.replace(old_text, new_text);
      note.updatedAt = new Date().toISOString();
      await saveNote(context.workspacePath, note);

      return {
        content: [
          { type: "text", text: JSON.stringify({ noteId, updated: true }) },
        ],
      };
    },
  );
}

function registerEditNoteLines(server: McpServer, context: ToolContext): void {
  server.tool(
    "edit_note_lines",
    "Edit specific lines in a note by replacing a range of lines.",
    {
      noteId: z.string().describe("The ID of the note to edit"),
      start_line: z
        .string()
        .describe("First line to replace (1-based, inclusive)"),
      end_line: z
        .string()
        .describe("Last line to replace (1-based, inclusive)"),
      new_content: z.string().describe("The replacement content"),
    },
    async ({ noteId, start_line, end_line, new_content }) => {
      const note = await loadNote(context.workspacePath, noteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Note "${noteId}" not found.` }],
          isError: true,
        };
      }

      const start = parseInt(start_line, 10);
      const end = parseInt(end_line, 10);

      if (isNaN(start) || isNaN(end)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: start_line and end_line must be valid integers.",
            },
          ],
          isError: true,
        };
      }

      const lines = note.content.split("\n");

      if (start < 1 || end < start || end > lines.length) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Invalid line range ${start}-${end}. Note has ${lines.length} lines.`,
            },
          ],
          isError: true,
        };
      }

      const newLines = new_content === "" ? [] : new_content.split("\n");
      lines.splice(start - 1, end - start + 1, ...newLines);
      note.content = lines.join("\n");
      note.updatedAt = new Date().toISOString();
      await saveNote(context.workspacePath, note);

      return {
        content: [
          { type: "text", text: JSON.stringify({ noteId, updated: true }) },
        ],
      };
    },
  );
}

function registerUpdateNoteMetadata(
  server: McpServer,
  context: ToolContext,
): void {
  server.tool(
    "update_note_metadata",
    "Update the title and/or tags of a note without changing the content.",
    {
      noteId: z.string().describe("The ID of the note to update"),
      title: z.string().optional().describe("New title for the note"),
      tags: z
        .string()
        .optional()
        .describe("Comma-separated list of tags"),
    },
    async ({ noteId, title, tags }) => {
      const note = await loadNote(context.workspacePath, noteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Note "${noteId}" not found.` }],
          isError: true,
        };
      }

      if (title !== undefined) {
        note.title = title;
      }
      if (tags !== undefined) {
        note.tags = tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }

      note.updatedAt = new Date().toISOString();
      await saveNote(context.workspacePath, note);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              noteId,
              title: note.title,
              tags: note.tags,
              updated: true,
            }),
          },
        ],
      };
    },
  );
}

export function registerNoteTools(
  server: McpServer,
  context: ToolContext,
): void {
  registerCreateNote(server, context);
  registerListNotes(server, context);
  registerReadNote(server, context);
  registerDeleteNote(server, context);
  registerSetNoteContent(server, context);
  registerAddToNote(server, context);
  registerEditNote(server, context);
  registerEditNoteLines(server, context);
  registerUpdateNoteMetadata(server, context);
}
