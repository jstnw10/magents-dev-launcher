import { z } from "zod";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./types.js";
import { loadNote, saveNote } from "./note-storage.js";
import {
  createSubscription,
  deleteSubscription,
  getValidCategoryWildcards,
} from "./subscription-storage.js";

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

function registerSubscribeToEvents(server: McpServer, context: ToolContext): void {
  server.tool(
    "subscribe_to_events",
    "Subscribe to workspace events. Returns a subscription ID for later unsubscribing.",
    {
      eventTypes: z
        .array(z.string())
        .describe(
          'Event type patterns to subscribe to. Use category wildcards like "agent:*", "file:*", etc.',
        ),
      excludeSelf: z
        .boolean()
        .optional()
        .describe("Exclude events caused by yourself (default: true)"),
      batchWindow: z
        .number()
        .optional()
        .describe("Milliseconds to batch events before delivery (default: 500)"),
    },
    async ({ eventTypes, excludeSelf, batchWindow }) => {
      if (!eventTypes || eventTypes.length === 0) {
        return {
          content: [{ type: "text", text: "Error: eventTypes must be a non-empty array." }],
          isError: true,
        };
      }

      // Expand bare "*" to all category wildcards
      let resolved = eventTypes;
      if (eventTypes.length === 1 && eventTypes[0] === "*") {
        resolved = getValidCategoryWildcards();
      }

      const sub = await createSubscription(context.workspacePath, {
        agentId: "mcp-caller",
        agentName: "mcp-caller",
        eventTypes: resolved,
        excludeActorIds: excludeSelf !== false ? ["mcp-caller"] : undefined,
        batchWindow: batchWindow ?? 500,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              subscriptionId: sub.id,
              eventTypes: sub.eventTypes,
            }),
          },
        ],
      };
    },
  );
}

function registerUnsubscribeFromEvents(server: McpServer, context: ToolContext): void {
  server.tool(
    "unsubscribe_from_events",
    "Unsubscribe from workspace events using a subscription ID.",
    {
      subscriptionId: z.string().describe("The subscription ID to cancel"),
    },
    async ({ subscriptionId }) => {
      const removed = await deleteSubscription(context.workspacePath, subscriptionId);
      if (!removed) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Subscription "${subscriptionId}" not found.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ unsubscribed: true }) }],
      };
    },
  );
}

function registerGetAgentSummary(server: McpServer, context: ToolContext): void {
  server.tool(
    "get_agent_summary",
    "Get a summary of what another agent did, including status, last response, and tool call counts.",
    {
      agentId: z.string().describe("ID of the agent to summarize"),
    },
    async ({ agentId }) => {
      const agentsDir = join(context.workspacePath, ".workspace", "opencode", "agents");
      const conversationsDir = join(context.workspacePath, ".workspace", "opencode", "conversations");

      // Load agent metadata
      const metadataFile = Bun.file(join(agentsDir, `${agentId}.json`));
      let metadata: Record<string, unknown> | null = null;
      if (await metadataFile.exists()) {
        metadata = JSON.parse(await metadataFile.text());
      }

      if (!metadata) {
        return {
          content: [{ type: "text", text: `Error: Agent "${agentId}" not found.` }],
          isError: true,
        };
      }

      // Load conversation (optional — may not exist)
      const convFile = Bun.file(join(conversationsDir, `${agentId}.json`));
      let messages: Array<Record<string, unknown>> = [];
      if (await convFile.exists()) {
        const conv = JSON.parse(await convFile.text()) as Record<string, unknown>;
        messages = (conv.messages as Array<Record<string, unknown>>) ?? [];
      }

      // Find last assistant message
      let lastResponse = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          const content = messages[i].content;
          if (typeof content === "string") {
            lastResponse = content;
          } else if (Array.isArray(content)) {
            lastResponse = (content as Array<{ text?: string }>)
              .filter((p) => p.text)
              .map((p) => p.text)
              .join("");
          }
          break;
        }
      }

      // Count tool calls across all messages
      let toolCallCount = 0;
      for (const msg of messages) {
        const parts = msg.parts as Array<Record<string, unknown>> | undefined;
        if (parts) {
          for (const part of parts) {
            if (part.type === "tool_use" || part.type === "tool_call" || part.type === "tool-invocation") {
              toolCallCount++;
            }
          }
        }
      }

      // Truncate last response
      const maxLen = 500;
      const truncatedResponse =
        lastResponse.length > maxLen
          ? lastResponse.slice(0, maxLen) + "..."
          : lastResponse;

      const summary = {
        agentId,
        name: metadata.label ?? metadata.name ?? agentId,
        status: metadata.completionReport ? "completed" : "active",
        messageCount: messages.length,
        toolCallCount,
        completionReport: metadata.completionReport ?? null,
        lastResponse: truncatedResponse || null,
      };

      // Build markdown summary
      const lines = [
        `## Agent: ${summary.name}`,
        `- **Status**: ${summary.status}`,
        `- **Messages**: ${summary.messageCount}`,
        `- **Tool calls**: ${summary.toolCallCount}`,
      ];
      if (summary.completionReport) {
        lines.push(`- **Completion report**: ${summary.completionReport}`);
      }
      if (summary.lastResponse) {
        lines.push("", "**Last response** (truncated):", summary.lastResponse);
      }

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(summary) },
        ],
      };
    },
  );
}

function registerWakeOrCreateTaskAgent(server: McpServer, context: ToolContext): void {
  server.tool(
    "wake_or_create_task_agent",
    "Wake an existing agent assigned to a task, or create a new one if none is found.",
    {
      taskNoteId: z.string().describe("ID of the task note"),
      contextMessage: z
        .string()
        .describe("Message to send to the agent with context about what to do"),
      model: z.string().optional().describe("Model to use for new agents"),
    },
    async ({ taskNoteId, contextMessage, model }) => {
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

      const assignedAgents = note.taskMetadata?.assignedAgents ?? [];

      // Try to find an existing agent that is still active
      const agentsDir = join(context.workspacePath, ".workspace", "opencode", "agents");

      for (let i = assignedAgents.length - 1; i >= 0; i--) {
        const existingId = assignedAgents[i];
        const agentFile = Bun.file(join(agentsDir, `${existingId}.json`));
        if (!(await agentFile.exists())) continue;

        const metadata = JSON.parse(await agentFile.text()) as Record<string, unknown>;
        // If the agent has a completion report, it's done — skip it
        if (metadata.completionReport) continue;

        // Agent looks active — send the context message
        try {
          await manager.sendMessage(context.workspacePath, existingId, contextMessage);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  action: "woke_existing",
                  agentId: existingId,
                  taskNoteId,
                  taskTitle: note.title,
                }),
              },
            ],
          };
        } catch {
          // Agent not reachable — continue to next or create new
          continue;
        }
      }

      // No suitable existing agent — create a new one
      const agentMetadata = await manager.createAgent(context.workspacePath, {
        label: note.title,
        model,
      });

      // Send context message
      await manager.sendMessage(context.workspacePath, agentMetadata.agentId, contextMessage);

      // Update task note with new assigned agent
      if (!note.taskMetadata) {
        note.taskMetadata = { status: "not_started" };
      }
      if (!note.taskMetadata.assignedAgents) {
        note.taskMetadata.assignedAgents = [];
      }
      note.taskMetadata.assignedAgents.push(agentMetadata.agentId);
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
              action: "created_new",
              agentId: agentMetadata.agentId,
              taskNoteId,
              taskTitle: note.title,
            }),
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
  registerSubscribeToEvents(server, context);
  registerUnsubscribeFromEvents(server, context);
  registerGetAgentSummary(server, context);
  registerWakeOrCreateTaskAgent(server, context);
}
