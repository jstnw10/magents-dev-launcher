import { z } from "zod";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./types.js";
import { loadNote, saveNote } from "./note-storage.js";

async function getManager(context: ToolContext) {
  if (!context.getAgentManager) {
    throw new Error("Agent manager is not available. The MCP server was started without agent support.");
  }
  return context.getAgentManager();
}

function registerCreateAgent(server: McpServer, context: ToolContext): void {
  server.tool(
    "create_agent",
    "Create a new agent. Optionally specify a specialist and/or an initial message.",
    {
      name: z.string().describe("Name for the new agent"),
      specialist: z.string().optional().describe("Specialist ID to use for the agent"),
      model: z.string().optional().describe("Model to use for the agent"),
      initialMessage: z.string().optional().describe("Message to send immediately after creation"),
    },
    async ({ name, specialist, model, initialMessage }) => {
      let managerInfo;
      try {
        managerInfo = await getManager(context);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const { manager } = managerInfo;

      let specialistId: string | undefined;
      let systemPrompt: string | undefined;

      if (specialist) {
        if (!context.specialistRegistry) {
          return {
            content: [{ type: "text", text: "Error: Specialist registry is not available." }],
            isError: true,
          };
        }
        const spec = await context.specialistRegistry.get(specialist);
        if (!spec) {
          return {
            content: [{ type: "text", text: `Error: Specialist "${specialist}" not found.` }],
            isError: true,
          };
        }
        specialistId = specialist;
        systemPrompt = spec.systemPrompt;
        model = model ?? spec.defaultModel;
      }

      const metadata = await manager.createAgent(context.workspacePath, {
        label: name,
        model,
        specialistId,
        systemPrompt,
      });

      const result: Record<string, unknown> = {
        agentId: metadata.agentId,
        name: metadata.label,
      };
      if (specialistId) result.specialistId = specialistId;

      if (initialMessage) {
        const response = await manager.sendMessage(context.workspacePath, metadata.agentId, initialMessage);
        result.response = {
          content: response.content,
          tokens: response.tokens,
          cost: response.cost,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );
}

function registerListAgents(server: McpServer, context: ToolContext): void {
  server.tool(
    "list_agents",
    "List all agents in the workspace.",
    {},
    async () => {
      let managerInfo;
      try {
        managerInfo = await getManager(context);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const agents = await managerInfo.manager.listAgents(context.workspacePath);
      return {
        content: [{ type: "text", text: JSON.stringify(agents) }],
      };
    },
  );
}

function registerGetAgentStatus(server: McpServer, context: ToolContext): void {
  server.tool(
    "get_agent_status",
    "Get the status and metadata of a specific agent.",
    {
      agentId: z.string().describe("The agent ID"),
    },
    async ({ agentId }) => {
      let managerInfo;
      try {
        managerInfo = await getManager(context);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      try {
        const agent = await managerInfo.manager.getAgent(context.workspacePath, agentId);
        return {
          content: [{ type: "text", text: JSON.stringify(agent) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function registerSendMessageToAgent(server: McpServer, context: ToolContext): void {
  server.tool(
    "send_message_to_agent",
    "Send a message to an agent and return the response.",
    {
      agentId: z.string().describe("The agent ID"),
      message: z.string().describe("The message to send"),
    },
    async ({ agentId, message }) => {
      let managerInfo;
      try {
        managerInfo = await getManager(context);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      try {
        const response = await managerInfo.manager.sendMessage(context.workspacePath, agentId, message);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                agentId,
                response: {
                  content: response.content,
                  tokens: response.tokens,
                  cost: response.cost,
                },
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function registerReadAgentConversation(server: McpServer, context: ToolContext): void {
  server.tool(
    "read_agent_conversation",
    "Read an agent's conversation history. Optionally limit to the last N messages.",
    {
      agentId: z.string().describe("The agent ID"),
      lastN: z.number().optional().describe("Only return the last N messages"),
    },
    async ({ agentId, lastN }) => {
      let managerInfo;
      try {
        managerInfo = await getManager(context);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      try {
        const conversation = await managerInfo.manager.getConversation(context.workspacePath, agentId);
        let messages = conversation.messages;
        if (lastN !== undefined && lastN > 0) {
          messages = messages.slice(-lastN);
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ agentId, messages }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function registerDelegateTask(server: McpServer, context: ToolContext): void {
  server.tool(
    "delegate_task",
    "Delegate a task note to a new agent. Creates an agent, sends the task content, and updates the task note.",
    {
      taskNoteId: z.string().describe("The ID of the task note to delegate"),
      specialist: z.string().optional().describe("Specialist ID for the new agent"),
      agentInstructions: z.string().optional().describe("Additional instructions for the agent"),
    },
    async ({ taskNoteId, specialist, agentInstructions }) => {
      let managerInfo;
      try {
        managerInfo = await getManager(context);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const { manager } = managerInfo;

      // Load task note
      const note = await loadNote(context.workspacePath, taskNoteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Task note "${taskNoteId}" not found.` }],
          isError: true,
        };
      }

      // Resolve specialist if provided
      let specialistId: string | undefined;
      let systemPrompt: string | undefined;
      let model: string | undefined;

      if (specialist) {
        if (!context.specialistRegistry) {
          return {
            content: [{ type: "text", text: "Error: Specialist registry is not available." }],
            isError: true,
          };
        }
        const spec = await context.specialistRegistry.get(specialist);
        if (!spec) {
          return {
            content: [{ type: "text", text: `Error: Specialist "${specialist}" not found.` }],
            isError: true,
          };
        }
        specialistId = specialist;
        systemPrompt = spec.systemPrompt;
        model = spec.defaultModel;
      }

      // Create agent
      const metadata = await manager.createAgent(context.workspacePath, {
        label: note.title,
        model,
        specialistId,
        systemPrompt,
      });

      // Build initial message
      let initialMessage = `# Task: ${note.title}\n\n${note.content}`;
      if (agentInstructions) {
        initialMessage += `\n\n## Additional Instructions\n${agentInstructions}`;
      }

      // Send initial message
      await manager.sendMessage(context.workspacePath, metadata.agentId, initialMessage);

      // Update task note metadata
      if (!note.taskMetadata) {
        note.taskMetadata = { status: "not_started" };
      }
      if (!note.taskMetadata.assignedAgents) {
        note.taskMetadata.assignedAgents = [];
      }
      note.taskMetadata.assignedAgents.push(metadata.agentId);
      if (note.taskMetadata.status === "not_started") {
        note.taskMetadata.status = "in_progress";
      }
      note.updatedAt = new Date().toISOString();
      await saveNote(context.workspacePath, note);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              agentId: metadata.agentId,
              taskNoteId,
              agentName: metadata.label,
            }),
          },
        ],
      };
    },
  );
}

function registerSendMessageToTaskAgent(server: McpServer, context: ToolContext): void {
  server.tool(
    "send_message_to_task_agent",
    "Send a message to the agent assigned to a task note.",
    {
      taskNoteId: z.string().describe("The ID of the task note"),
      message: z.string().describe("The message to send"),
    },
    async ({ taskNoteId, message }) => {
      let managerInfo;
      try {
        managerInfo = await getManager(context);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const { manager } = managerInfo;

      // Load task note
      const note = await loadNote(context.workspacePath, taskNoteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Error: Task note "${taskNoteId}" not found.` }],
          isError: true,
        };
      }

      const assignedAgents = note.taskMetadata?.assignedAgents;
      if (!assignedAgents || assignedAgents.length === 0) {
        return {
          content: [{ type: "text", text: `Error: No agents assigned to task "${taskNoteId}".` }],
          isError: true,
        };
      }

      // Send to the last assigned agent
      const agentId = assignedAgents[assignedAgents.length - 1];
      const response = await manager.sendMessage(context.workspacePath, agentId, message);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              agentId,
              response: {
                content: response.content,
                tokens: response.tokens,
                cost: response.cost,
              },
            }),
          },
        ],
      };
    },
  );
}

function registerReportToParent(server: McpServer, context: ToolContext): void {
  server.tool(
    "report_to_parent",
    "Store a completion report for an agent. Used by delegated agents to report results.",
    {
      agentId: z.string().optional().describe("The agent ID (optional)"),
      report: z.string().describe("The completion report text"),
    },
    async ({ agentId, report }) => {
      if (agentId) {
        // Store the report in the agent's metadata file
        const agentPath = join(
          context.workspacePath,
          ".workspace",
          "opencode",
          "agents",
          `${agentId}.json`,
        );
        const file = Bun.file(agentPath);
        if (await file.exists()) {
          const metadata = JSON.parse(await file.text());
          metadata.completionReport = report;
          metadata.completedAt = new Date().toISOString();
          await Bun.write(agentPath, JSON.stringify(metadata, null, 2) + "\n");
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ reported: true }),
          },
        ],
      };
    },
  );
}

export function registerAgentTools(server: McpServer, context: ToolContext): void {
  registerCreateAgent(server, context);
  registerListAgents(server, context);
  registerGetAgentStatus(server, context);
  registerSendMessageToAgent(server, context);
  registerReadAgentConversation(server, context);
  registerDelegateTask(server, context);
  registerSendMessageToTaskAgent(server, context);
  registerReportToParent(server, context);
}
