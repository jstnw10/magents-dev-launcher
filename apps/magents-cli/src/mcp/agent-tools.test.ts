import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, realpath, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MagentsMcpServer } from "./server";
import { registerAgentTools } from "./agent-tools";
import { saveNote, loadNote, type Note } from "./note-storage";
import type { AgentManager, AgentMetadata, ConversationMessage, Conversation } from "../agent-manager";
import type { SpecialistRegistry, SpecialistDefinition } from "../specialist-registry";
import type { ToolContext } from "./types";

// --- Mock helpers ---

function createMockAgentManager(): AgentManager {
  const agents = new Map<string, AgentMetadata>();
  const conversations = new Map<string, ConversationMessage[]>();
  let agentCounter = 0;

  return {
    async createAgent(_workspacePath: string, options: {
      label: string;
      model?: string;
      specialistId?: string;
      systemPrompt?: string;
    }): Promise<AgentMetadata> {
      agentCounter++;
      const agentId = `agent-mock-${agentCounter}`;
      const metadata: AgentMetadata = {
        agentId,
        sessionId: `session-${agentCounter}`,
        label: options.label,
        model: options.model,
        specialistId: options.specialistId,
        systemPrompt: options.systemPrompt,
        createdAt: new Date().toISOString(),
      };
      agents.set(agentId, metadata);
      conversations.set(agentId, []);
      return metadata;
    },

    async listAgents(_workspacePath: string): Promise<AgentMetadata[]> {
      return Array.from(agents.values());
    },

    async getAgent(_workspacePath: string, agentId: string): Promise<AgentMetadata> {
      const agent = agents.get(agentId);
      if (!agent) throw new Error(`Agent "${agentId}" not found.`);
      return agent;
    },

    async sendMessage(_workspacePath: string, agentId: string, text: string): Promise<ConversationMessage> {
      const agent = agents.get(agentId);
      if (!agent) throw new Error(`Agent "${agentId}" not found.`);

      const response: ConversationMessage = {
        role: "assistant",
        content: `Mock response to: ${text.slice(0, 50)}`,
        parts: [{ type: "text", text: `Mock response to: ${text.slice(0, 50)}` }],
        timestamp: new Date().toISOString(),
        tokens: { input: 10, output: 20 },
        cost: 0.001,
      };

      const conv = conversations.get(agentId) ?? [];
      conv.push(
        { role: "user", content: text, parts: [{ type: "text", text }], timestamp: new Date().toISOString() },
        response,
      );
      conversations.set(agentId, conv);

      return response;
    },

    async getConversation(_workspacePath: string, agentId: string): Promise<Conversation> {
      const agent = agents.get(agentId);
      if (!agent) throw new Error(`Agent "${agentId}" not found.`);
      return {
        agentId,
        sessionId: agent.sessionId,
        messages: conversations.get(agentId) ?? [],
      };
    },

    async removeAgent(_workspacePath: string, agentId: string): Promise<void> {
      agents.delete(agentId);
      conversations.delete(agentId);
    },
  } as AgentManager;
}

function createMockSpecialistRegistry(specialists: Record<string, SpecialistDefinition> = {}): SpecialistRegistry {
  return {
    async get(id: string): Promise<SpecialistDefinition | null> {
      return specialists[id] ?? null;
    },
    async list(): Promise<SpecialistDefinition[]> {
      return Object.values(specialists);
    },
  } as SpecialistRegistry;
}

function parseToolResult(result: { content: unknown }): unknown {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

function getToolText(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

async function setupClientAndServer(
  workspacePath: string,
  contextOverrides?: Partial<Omit<ToolContext, "workspacePath">>,
) {
  const server = new MagentsMcpServer(workspacePath, contextOverrides);
  server.registerTools([registerAgentTools]);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    client.connect(clientTransport),
    server.mcpServer.connect(serverTransport),
  ]);

  return { client, server };
}

async function createTestNote(
  workspacePath: string,
  overrides: Partial<Note> = {},
): Promise<Note> {
  const now = new Date().toISOString();
  const note: Note = {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? "Test Note",
    content: overrides.content ?? "Test content",
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
  await saveNote(workspacePath, note);
  return note;
}

describe("agent-tools", () => {
  let tmpDir: string;
  let mockManager: AgentManager;
  let mockRegistry: SpecialistRegistry;

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "magents-at-test-")));
    mockManager = createMockAgentManager();
    mockRegistry = createMockSpecialistRegistry({
      implementor: {
        id: "implementor",
        name: "Implementor",
        description: "Implementation specialist",
        systemPrompt: "You are an implementor.",
        defaultModel: "fast-model",
        source: "builtin",
      },
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function getContext(): Partial<Omit<ToolContext, "workspacePath">> {
    return {
      getAgentManager: async () => ({ manager: mockManager, serverUrl: "http://localhost:1234" }),
      specialistRegistry: mockRegistry,
    };
  }

  describe("create_agent", () => {
    it("creates an agent and returns metadata", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const result = await client.callTool({
        name: "create_agent",
        arguments: { name: "My Agent" },
      });
      const parsed = parseToolResult(result) as { agentId: string; name: string };

      expect(parsed.agentId).toMatch(/^agent-mock-/);
      expect(parsed.name).toBe("My Agent");

      await client.close();
      await server.mcpServer.close();
    });

    it("resolves specialist from registry", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const result = await client.callTool({
        name: "create_agent",
        arguments: { name: "Impl Agent", specialist: "implementor" },
      });
      const parsed = parseToolResult(result) as { agentId: string; specialistId: string };

      expect(parsed.specialistId).toBe("implementor");

      await client.close();
      await server.mcpServer.close();
    });

    it("errors when specialist not found", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const result = await client.callTool({
        name: "create_agent",
        arguments: { name: "Agent", specialist: "nonexistent" },
      });

      expect(result.isError).toBe(true);
      expect(getToolText(result)).toContain("not found");

      await client.close();
      await server.mcpServer.close();
    });

    it("sends initialMessage if provided", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const result = await client.callTool({
        name: "create_agent",
        arguments: { name: "Chat Agent", initialMessage: "Hello!" },
      });
      const parsed = parseToolResult(result) as { agentId: string; response: { content: string } };

      expect(parsed.response).toBeDefined();
      expect(parsed.response.content).toContain("Mock response");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("list_agents", () => {
    it("returns all agents", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      // Create two agents first
      await client.callTool({ name: "create_agent", arguments: { name: "Agent A" } });
      await client.callTool({ name: "create_agent", arguments: { name: "Agent B" } });

      const result = await client.callTool({ name: "list_agents", arguments: {} });
      const parsed = parseToolResult(result) as Array<{ label: string }>;

      expect(parsed).toHaveLength(2);
      expect(parsed.map((a) => a.label)).toContain("Agent A");
      expect(parsed.map((a) => a.label)).toContain("Agent B");

      await client.close();
      await server.mcpServer.close();
    });

    it("returns empty array when no agents exist", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const result = await client.callTool({ name: "list_agents", arguments: {} });
      const parsed = parseToolResult(result) as unknown[];

      expect(parsed).toHaveLength(0);

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("get_agent_status", () => {
    it("returns agent metadata", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const createResult = await client.callTool({
        name: "create_agent",
        arguments: { name: "Status Agent" },
      });
      const { agentId } = parseToolResult(createResult) as { agentId: string };

      const result = await client.callTool({
        name: "get_agent_status",
        arguments: { agentId },
      });
      const parsed = parseToolResult(result) as { agentId: string; label: string };

      expect(parsed.agentId).toBe(agentId);
      expect(parsed.label).toBe("Status Agent");

      await client.close();
      await server.mcpServer.close();
    });

    it("errors for unknown agent", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const result = await client.callTool({
        name: "get_agent_status",
        arguments: { agentId: "agent-nonexistent" },
      });

      expect(result.isError).toBe(true);
      expect(getToolText(result)).toContain("not found");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("send_message_to_agent", () => {
    it("sends message and returns response", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const createResult = await client.callTool({
        name: "create_agent",
        arguments: { name: "Chat Agent" },
      });
      const { agentId } = parseToolResult(createResult) as { agentId: string };

      const result = await client.callTool({
        name: "send_message_to_agent",
        arguments: { agentId, message: "Hello agent!" },
      });
      const parsed = parseToolResult(result) as { agentId: string; response: { content: string; tokens: object; cost: number } };

      expect(parsed.agentId).toBe(agentId);
      expect(parsed.response.content).toContain("Mock response");
      expect(parsed.response.tokens).toBeDefined();
      expect(parsed.response.cost).toBeDefined();

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("read_agent_conversation", () => {
    it("returns conversation messages", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const createResult = await client.callTool({
        name: "create_agent",
        arguments: { name: "Conv Agent" },
      });
      const { agentId } = parseToolResult(createResult) as { agentId: string };

      // Send a message to populate conversation
      await client.callTool({
        name: "send_message_to_agent",
        arguments: { agentId, message: "First message" },
      });

      const result = await client.callTool({
        name: "read_agent_conversation",
        arguments: { agentId },
      });
      const parsed = parseToolResult(result) as { agentId: string; messages: Array<{ role: string }> };

      expect(parsed.agentId).toBe(agentId);
      expect(parsed.messages).toHaveLength(2); // user + assistant
      expect(parsed.messages[0].role).toBe("user");
      expect(parsed.messages[1].role).toBe("assistant");

      await client.close();
      await server.mcpServer.close();
    });

    it("limits messages with lastN", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const createResult = await client.callTool({
        name: "create_agent",
        arguments: { name: "Conv Agent" },
      });
      const { agentId } = parseToolResult(createResult) as { agentId: string };

      // Send two messages (4 total: 2 user + 2 assistant)
      await client.callTool({
        name: "send_message_to_agent",
        arguments: { agentId, message: "First" },
      });
      await client.callTool({
        name: "send_message_to_agent",
        arguments: { agentId, message: "Second" },
      });

      const result = await client.callTool({
        name: "read_agent_conversation",
        arguments: { agentId, lastN: 2 },
      });
      const parsed = parseToolResult(result) as { messages: unknown[] };

      expect(parsed.messages).toHaveLength(2);

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("delegate_task", () => {
    it("creates agent, sends task content, updates assignedAgents", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const note = await createTestNote(tmpDir, {
        title: "My Task",
        content: "Implement feature X",
        taskMetadata: { status: "not_started" },
      });

      const result = await client.callTool({
        name: "delegate_task",
        arguments: { taskNoteId: note.id },
      });
      const parsed = parseToolResult(result) as { agentId: string; taskNoteId: string; agentName: string };

      expect(parsed.agentId).toMatch(/^agent-mock-/);
      expect(parsed.taskNoteId).toBe(note.id);
      expect(parsed.agentName).toBe("My Task");

      // Verify the task note was updated
      const updated = await loadNote(tmpDir, note.id);
      expect(updated!.taskMetadata!.assignedAgents).toContain(parsed.agentId);
      expect(updated!.taskMetadata!.status).toBe("in_progress");

      await client.close();
      await server.mcpServer.close();
    });

    it("includes agentInstructions in initial message", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const note = await createTestNote(tmpDir, {
        title: "Task With Instructions",
        content: "Do the thing",
        taskMetadata: { status: "not_started" },
      });

      const result = await client.callTool({
        name: "delegate_task",
        arguments: {
          taskNoteId: note.id,
          agentInstructions: "Focus on performance",
        },
      });
      const parsed = parseToolResult(result) as { agentId: string };

      expect(parsed.agentId).toBeDefined();

      await client.close();
      await server.mcpServer.close();
    });

    it("resolves specialist for delegated agent", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const note = await createTestNote(tmpDir, {
        title: "Specialist Task",
        content: "Build it",
        taskMetadata: { status: "not_started" },
      });

      const result = await client.callTool({
        name: "delegate_task",
        arguments: { taskNoteId: note.id, specialist: "implementor" },
      });

      expect(result.isError).toBeFalsy();

      await client.close();
      await server.mcpServer.close();
    });

    it("errors when task note not found", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const result = await client.callTool({
        name: "delegate_task",
        arguments: { taskNoteId: "nonexistent-id" },
      });

      expect(result.isError).toBe(true);
      expect(getToolText(result)).toContain("not found");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("send_message_to_task_agent", () => {
    it("finds assigned agent and sends message", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      // Create a task note and delegate it
      const note = await createTestNote(tmpDir, {
        title: "Task for Agent",
        content: "Do work",
        taskMetadata: { status: "not_started" },
      });

      const delegateResult = await client.callTool({
        name: "delegate_task",
        arguments: { taskNoteId: note.id },
      });
      const { agentId } = parseToolResult(delegateResult) as { agentId: string };

      // Now send a message to the task agent
      const result = await client.callTool({
        name: "send_message_to_task_agent",
        arguments: { taskNoteId: note.id, message: "How's it going?" },
      });
      const parsed = parseToolResult(result) as { agentId: string; response: { content: string } };

      expect(parsed.agentId).toBe(agentId);
      expect(parsed.response.content).toContain("Mock response");

      await client.close();
      await server.mcpServer.close();
    });

    it("errors when no agents assigned", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const note = await createTestNote(tmpDir, {
        title: "Unassigned Task",
        content: "No agent yet",
        taskMetadata: { status: "not_started" },
      });

      const result = await client.callTool({
        name: "send_message_to_task_agent",
        arguments: { taskNoteId: note.id, message: "Hello?" },
      });

      expect(result.isError).toBe(true);
      expect(getToolText(result)).toContain("No agents assigned");

      await client.close();
      await server.mcpServer.close();
    });

    it("errors when task note not found", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const result = await client.callTool({
        name: "send_message_to_task_agent",
        arguments: { taskNoteId: "nonexistent-id", message: "Hello?" },
      });

      expect(result.isError).toBe(true);
      expect(getToolText(result)).toContain("not found");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("report_to_parent", () => {
    it("stores report when agentId provided", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      // Create agent metadata file manually to test report storage
      const agentId = "agent-test-report";
      const agentsDir = join(tmpDir, ".workspace", "opencode", "agents");
      await mkdir(agentsDir, { recursive: true });
      await Bun.write(
        join(agentsDir, `${agentId}.json`),
        JSON.stringify({ agentId, label: "Reporter" }) + "\n",
      );

      const result = await client.callTool({
        name: "report_to_parent",
        arguments: { agentId, report: "Task completed successfully" },
      });
      const parsed = parseToolResult(result) as { reported: boolean };

      expect(parsed.reported).toBe(true);

      // Verify the report was stored
      const file = Bun.file(join(agentsDir, `${agentId}.json`));
      const metadata = JSON.parse(await file.text());
      expect(metadata.completionReport).toBe("Task completed successfully");
      expect(metadata.completedAt).toBeDefined();

      await client.close();
      await server.mcpServer.close();
    });

    it("succeeds without agentId", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, getContext());

      const result = await client.callTool({
        name: "report_to_parent",
        arguments: { report: "Done!" },
      });
      const parsed = parseToolResult(result) as { reported: boolean };

      expect(parsed.reported).toBe(true);

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("error handling", () => {
    it("tools error gracefully when agent manager not available", async () => {
      // No getAgentManager in context
      const { client, server } = await setupClientAndServer(tmpDir, {});

      const result = await client.callTool({
        name: "create_agent",
        arguments: { name: "Agent" },
      });

      expect(result.isError).toBe(true);
      expect(getToolText(result)).toContain("not available");

      await client.close();
      await server.mcpServer.close();
    });

    it("list_agents errors when agent manager not available", async () => {
      const { client, server } = await setupClientAndServer(tmpDir, {});

      const result = await client.callTool({
        name: "list_agents",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(getToolText(result)).toContain("not available");

      await client.close();
      await server.mcpServer.close();
    });
  });
});
