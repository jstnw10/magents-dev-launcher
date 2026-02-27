import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./types.js";
import { loadNote, saveNote } from "./note-storage.js";
import { REFERENCE_DOCS } from "./reference-docs.js";

function appendWsBlock(content: string, type: string, json: object): string {
  const block = `\n\n\`\`\`ws-block:${type}\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
  return content + block;
}

function registerAddReferencePrimitive(server: McpServer, context: ToolContext): void {
  server.tool(
    "add_reference_primitive",
    "Add a code reference primitive to a note. Creates a link to specific code in the codebase.",
    {
      noteId: z.string().describe("The ID of the note to add the primitive to"),
      semanticId: z
        .string()
        .describe(
          'Semantic ID like "src/main.ts#symbol:MainClass.init" or "src/utils.ts#L10-20"',
        ),
      description: z
        .string()
        .describe("Human-readable description of what this references"),
      snapshot: z
        .string()
        .optional()
        .describe("Optional: Current code snapshot for offline viewing"),
    },
    async ({ noteId, semanticId, description, snapshot }) => {
      const note = await loadNote(context.workspacePath, noteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Note "${noteId}" not found.` }],
          isError: true,
        };
      }

      const isSymbol = semanticId.includes("#symbol:");
      const filePath = semanticId.split("#")[0];

      const primitive: Record<string, unknown> = {
        id: crypto.randomUUID(),
        version: 1,
        type: "reference",
        createdAt: new Date().toISOString(),
        createdBy: "agent",
        target: {
          kind: isSymbol ? "symbol" : "file_range",
          semanticId,
        },
        description,
      };

      if (snapshot) {
        const ext = filePath.split(".").pop() ?? "";
        primitive.snapshot = {
          code: snapshot,
          filePath,
          language: ext,
        };
      }

      note.content = appendWsBlock(note.content, "reference", primitive);
      note.updatedAt = new Date().toISOString();
      await saveNote(context.workspacePath, note);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ primitiveId: primitive.id, noteId }),
          },
        ],
      };
    },
  );
}

function registerAddCliPrimitive(server: McpServer, context: ToolContext): void {
  server.tool(
    "add_cli_primitive",
    "Add a CLI command primitive to a note. Creates an executable command block.",
    {
      noteId: z.string().describe("The ID of the note to add the primitive to"),
      command: z.string().describe("The command to execute"),
      description: z.string().describe("Description of what this command does"),
      workingDirectory: z
        .string()
        .optional()
        .describe(
          "Working directory for the command (optional, defaults to workspace root)",
        ),
    },
    async ({ noteId, command, description, workingDirectory }) => {
      const note = await loadNote(context.workspacePath, noteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Note "${noteId}" not found.` }],
          isError: true,
        };
      }

      const primitive = {
        id: crypto.randomUUID(),
        version: 1,
        type: "cli",
        createdAt: new Date().toISOString(),
        createdBy: "agent",
        command,
        description,
        cwd: workingDirectory ?? "./",
      };

      note.content = appendWsBlock(note.content, "cli", primitive);
      note.updatedAt = new Date().toISOString();
      await saveNote(context.workspacePath, note);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ primitiveId: primitive.id, noteId }),
          },
        ],
      };
    },
  );
}

function registerAddPatchPrimitive(server: McpServer, context: ToolContext): void {
  server.tool(
    "add_patch_primitive",
    "Add a patch primitive to a note. Creates an applyable code diff block.",
    {
      noteId: z.string().describe("The ID of the note to add the primitive to"),
      filePath: z.string().describe("Path to the file this patch applies to"),
      diff: z.string().describe("The unified diff content"),
      description: z.string().describe("Description of what this patch does"),
    },
    async ({ noteId, filePath, diff, description }) => {
      const note = await loadNote(context.workspacePath, noteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Note "${noteId}" not found.` }],
          isError: true,
        };
      }

      const primitive = {
        id: crypto.randomUUID(),
        version: 1,
        type: "patch",
        createdAt: new Date().toISOString(),
        createdBy: "agent",
        description,
        patches: [{ filePath, diff }],
      };

      note.content = appendWsBlock(note.content, "patch", primitive);
      note.updatedAt = new Date().toISOString();
      await saveNote(context.workspacePath, note);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ primitiveId: primitive.id, noteId }),
          },
        ],
      };
    },
  );
}

function registerAddAgentActionPrimitive(server: McpServer, context: ToolContext): void {
  server.tool(
    "add_agent_action_primitive",
    "Add an agent action primitive to a note. Creates a triggerable agent task block.",
    {
      noteId: z.string().describe("The ID of the note to add the primitive to"),
      agentId: z
        .string()
        .describe('Agent identifier (e.g., "refactor", "explainer", "planner")'),
      goal: z.string().describe("The goal/instruction for the agent"),
      description: z
        .string()
        .describe("Description of what this agent action does"),
    },
    async ({ noteId, agentId, goal, description }) => {
      const note = await loadNote(context.workspacePath, noteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Note "${noteId}" not found.` }],
          isError: true,
        };
      }

      const primitive = {
        id: crypto.randomUUID(),
        version: 1,
        type: "agent_action",
        createdAt: new Date().toISOString(),
        createdBy: "agent",
        agentId,
        goal,
        description,
        inputs: [],
      };

      note.content = appendWsBlock(note.content, "agent_action", primitive);
      note.updatedAt = new Date().toISOString();
      await saveNote(context.workspacePath, note);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ primitiveId: primitive.id, noteId }),
          },
        ],
      };
    },
  );
}

function registerGetReferenceDocs(server: McpServer, _context: ToolContext): void {
  server.tool(
    "get_reference_docs",
    "Get detailed documentation for workspace features. Available topics: diagrams, ws-blocks, tasks",
    {
      topic: z
        .string()
        .describe("The topic to get documentation for. One of: diagrams, ws-blocks, tasks"),
    },
    async ({ topic }) => {
      const doc = REFERENCE_DOCS[topic];
      if (!doc) {
        const available = Object.keys(REFERENCE_DOCS).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Error: Unknown topic "${topic}". Available topics: ${available}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: doc }],
      };
    },
  );
}

export function registerPrimitiveTools(server: McpServer, context: ToolContext): void {
  registerAddReferencePrimitive(server, context);
  registerAddCliPrimitive(server, context);
  registerAddPatchPrimitive(server, context);
  registerAddAgentActionPrimitive(server, context);
  registerGetReferenceDocs(server, context);
}
