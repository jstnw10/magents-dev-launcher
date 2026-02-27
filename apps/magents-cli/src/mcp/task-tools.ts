import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./types.js";
import { loadNote, saveNote } from "./note-storage.js";

interface ParsedTask {
  line: number;
  text: string;
  status: "todo" | "done" | "in-progress";
  linkedTaskNoteId?: string;
}

const TASK_REGEX = /^(\s*)-\s+\[([ x/])\]\s+(.*)$/;
const INTENT_LINK_REGEX = /\[.*?\]\(intent:\/\/local\/task\/([^)]+)\)/;

function parseTaskLine(
  line: string,
  lineNumber: number,
): ParsedTask | null {
  const match = line.match(TASK_REGEX);
  if (!match) return null;

  const marker = match[2];
  const text = match[3];
  const status: ParsedTask["status"] =
    marker === "x" ? "done" : marker === "/" ? "in-progress" : "todo";

  const linkMatch = text.match(INTENT_LINK_REGEX);
  const linkedTaskNoteId = linkMatch ? linkMatch[1] : undefined;

  return { line: lineNumber, text, status, linkedTaskNoteId };
}

function statusToMarker(status: "todo" | "done" | "in-progress"): string {
  if (status === "done") return "x";
  if (status === "in-progress") return "/";
  return " ";
}

function formatContentWithLineNumbers(content: string): string {
  const lines = content.split("\n");
  const width = String(lines.length).length;
  return lines
    .map((line, i) => {
      const num = String(i + 1).padStart(width, " ");
      return `${num} | ${line}`;
    })
    .join("\n");
}

function registerListNoteTasks(server: McpServer, context: ToolContext): void {
  server.tool(
    "list_note_tasks",
    "List all task checkboxes in a note. Returns task text, status, linked task note IDs, and line numbers.",
    {
      noteId: z.string().describe("The ID of the note to list tasks from"),
    },
    async ({ noteId }) => {
      const note = await loadNote(context.workspacePath, noteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Note "${noteId}" not found.` }],
          isError: true,
        };
      }

      const lines = note.content.split("\n");
      const tasks: ParsedTask[] = [];

      for (let i = 0; i < lines.length; i++) {
        const task = parseTaskLine(lines[i], i + 1);
        if (task) tasks.push(task);
      }

      // Build human-readable summary
      const statusMap = { todo: "[ ]", done: "[x]", "in-progress": "[/]" };
      const summary = tasks.map((t) => {
        const linked = t.linkedTaskNoteId
          ? ` → task note: ${t.linkedTaskNoteId}`
          : "";
        return `  Line ${t.line}: ${statusMap[t.status]} ${t.text}${linked}`;
      });

      const header = `Tasks in "${note.title}" (${tasks.length} tasks):`;
      const text =
        tasks.length > 0
          ? `${header}\n${summary.join("\n")}`
          : `${header}\n  (no tasks found)`;

      return {
        content: [
          {
            type: "text",
            text: `${text}\n\n${JSON.stringify(tasks)}`,
          },
        ],
      };
    },
  );
}

function registerUpdateTask(server: McpServer, context: ToolContext): void {
  server.tool(
    "update_task",
    "Update a specific task line by line number. Can change text, status, or both.",
    {
      noteId: z.string().describe("The ID of the note containing the task"),
      lineNumber: z.number().describe("The 1-based line number of the task to update"),
      newText: z.string().optional().describe("New text for the task (without checkbox prefix)"),
      status: z
        .enum(["todo", "in-progress", "done"])
        .optional()
        .describe("New status for the task"),
    },
    async ({ noteId, lineNumber, newText, status }) => {
      const note = await loadNote(context.workspacePath, noteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Note "${noteId}" not found.` }],
          isError: true,
        };
      }

      const lines = note.content.split("\n");

      if (lineNumber < 1 || lineNumber > lines.length) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Line number ${lineNumber} out of range. Note has ${lines.length} lines.`,
            },
          ],
          isError: true,
        };
      }

      const line = lines[lineNumber - 1];
      const match = line.match(TASK_REGEX);

      if (!match) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Line ${lineNumber} is not a task checkbox line.`,
            },
          ],
          isError: true,
        };
      }

      const indent = match[1];
      const currentMarker = match[2];
      const currentText = match[3];

      const marker = status ? statusToMarker(status) : currentMarker;
      const text = newText !== undefined ? newText : currentText;

      lines[lineNumber - 1] = `${indent}- [${marker}] ${text}`;
      note.content = lines.join("\n");
      note.updatedAt = new Date().toISOString();
      await saveNote(context.workspacePath, note);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ noteId, lineNumber, updated: true }),
          },
        ],
      };
    },
  );
}

function registerUpdateTaskStatus(server: McpServer, context: ToolContext): void {
  server.tool(
    "update_task_status",
    "Find a task by matching its text content and update its checkbox status.",
    {
      noteId: z.string().describe("The ID of the note containing the task"),
      taskText: z.string().describe("The text content of the task to update (without the checkbox)"),
      status: z
        .enum(["done", "todo", "in-progress"])
        .describe("The new status"),
    },
    async ({ noteId, taskText, status }) => {
      const note = await loadNote(context.workspacePath, noteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Note "${noteId}" not found.` }],
          isError: true,
        };
      }

      const lines = note.content.split("\n");
      const matchingLines: number[] = [];

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(TASK_REGEX);
        if (match && match[3].includes(taskText)) {
          matchingLines.push(i);
        }
      }

      if (matchingLines.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Error: No task found matching "${taskText}".`,
            },
          ],
          isError: true,
        };
      }

      if (matchingLines.length > 1) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Multiple tasks (${matchingLines.length}) match "${taskText}". Be more specific.`,
            },
          ],
          isError: true,
        };
      }

      const lineIdx = matchingLines[0];
      const match = lines[lineIdx].match(TASK_REGEX)!;
      const indent = match[1];
      const text = match[3];
      const marker = statusToMarker(status);

      lines[lineIdx] = `${indent}- [${marker}] ${text}`;
      note.content = lines.join("\n");
      note.updatedAt = new Date().toISOString();
      await saveNote(context.workspacePath, note);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ noteId, updated: true }),
          },
        ],
      };
    },
  );
}

function registerMarkAsTask(server: McpServer, context: ToolContext): void {
  server.tool(
    "mark_as_task",
    "Convert a note into a task by adding task metadata (status, acceptance criteria).",
    {
      noteId: z.string().describe("The ID of the note to mark as a task"),
      status: z.string().describe("Task status"),
      acceptanceCriteria: z
        .string()
        .optional()
        .describe("JSON array of acceptance criteria strings"),
    },
    async ({ noteId, status, acceptanceCriteria }) => {
      const note = await loadNote(context.workspacePath, noteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Note "${noteId}" not found.` }],
          isError: true,
        };
      }

      note.taskMetadata = {
        status,
        acceptanceCriteria: acceptanceCriteria
          ? JSON.parse(acceptanceCriteria)
          : undefined,
      };
      note.updatedAt = new Date().toISOString();
      await saveNote(context.workspacePath, note);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ noteId, status }),
          },
        ],
      };
    },
  );
}

function registerUpdateNoteTaskStatus(server: McpServer, context: ToolContext): void {
  server.tool(
    "update_note_task_status",
    "Update the task metadata status on a task note.",
    {
      noteId: z.string().describe("The ID of the task note to update"),
      status: z.string().describe("The new task status"),
    },
    async ({ noteId, status }) => {
      const note = await loadNote(context.workspacePath, noteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Note "${noteId}" not found.` }],
          isError: true,
        };
      }

      if (!note.taskMetadata) {
        note.taskMetadata = { status };
      } else {
        note.taskMetadata.status = status;
      }

      note.updatedAt = new Date().toISOString();
      await saveNote(context.workspacePath, note);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ noteId, status }),
          },
        ],
      };
    },
  );
}

function registerGetMyTask(server: McpServer, context: ToolContext): void {
  server.tool(
    "get_my_task",
    "Read a task note and return its full content with task metadata.",
    {
      taskNoteId: z.string().describe("The ID of the task note to retrieve"),
    },
    async ({ taskNoteId }) => {
      const note = await loadNote(context.workspacePath, taskNoteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Task note "${taskNoteId}" not found.` }],
          isError: true,
        };
      }

      const formatted = formatContentWithLineNumbers(note.content);
      const result = {
        id: note.id,
        title: note.title,
        content: formatted,
        taskMetadata: note.taskMetadata ?? null,
        tags: note.tags,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}

export function registerTaskTools(
  server: McpServer,
  context: ToolContext,
): void {
  registerListNoteTasks(server, context);
  registerUpdateTask(server, context);
  registerUpdateTaskStatus(server, context);
  registerMarkAsTask(server, context);
  registerUpdateNoteTaskStatus(server, context);
  registerGetMyTask(server, context);
}
