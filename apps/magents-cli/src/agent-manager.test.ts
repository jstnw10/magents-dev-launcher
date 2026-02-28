import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  AgentManager,
  type OpenCodeClientInterface,
  type AgentMetadata,
} from "./agent-manager";
import { OrchestrationError } from "./types";

function createMockClient(
  overrides?: Partial<OpenCodeClientInterface["session"]>,
): OpenCodeClientInterface {
  return {
    session: {
      create: async () => ({
        data: { id: "session-abc-123", slug: "test-session", title: "Test" },
      }),
      prompt: async () => ({
        data: {
          info: {
            id: "msg-1",
            role: "assistant",
            tokens: { input: 10, output: 20 },
            cost: 0.001,
          },
          parts: [{ type: "text", text: "Hello from the assistant!" }],
        },
      }),
      messages: async () => ({
        data: [
          {
            info: { id: "msg-0", role: "user", time: { created: 1000 } },
            parts: [{ type: "text", text: "Hi" }],
          },
          {
            info: { id: "msg-1", role: "assistant", time: { created: 1001 } },
            parts: [{ type: "text", text: "Hello!" }],
          },
        ],
      }),
      delete: async () => {},
      ...overrides,
    },
  };
}

function tmpWorkspace(): string {
  return path.join(
    tmpdir(),
    `agent-manager-test-${Bun.randomUUIDv7().slice(0, 8)}`,
  );
}

describe("AgentManager", () => {
  let workspacePath: string;
  let manager: AgentManager;
  let mockClient: OpenCodeClientInterface;

  beforeEach(() => {
    workspacePath = tmpWorkspace();
    mockClient = createMockClient();
    manager = new AgentManager({ client: mockClient });
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  describe("createAgent", () => {
    it("creates an agent and stores metadata file", async () => {
      const agent = await manager.createAgent(workspacePath, {
        label: "my-agent",
        model: "gpt-4",
      });

      expect(agent.agentId).toMatch(/^agent-[a-f0-9]{8}$/);
      expect(agent.sessionId).toBe("session-abc-123");
      expect(agent.label).toBe("my-agent");
      expect(agent.model).toBe("gpt-4");
      expect(agent.createdAt).toBeTruthy();

      // Verify file was written
      const filePath = path.join(
        workspacePath,
        ".workspace",
        "opencode",
        "agents",
        `${agent.agentId}.json`,
      );
      const file = Bun.file(filePath);
      expect(await file.exists()).toBe(true);

      const stored = JSON.parse(await file.text()) as AgentMetadata;
      expect(stored.agentId).toBe(agent.agentId);
      expect(stored.sessionId).toBe("session-abc-123");
    });

    it("calls client.session.create with workspace directory and label", async () => {
      let capturedParams: unknown;
      const client = createMockClient({
        create: async (params) => {
          capturedParams = params;
          return {
            data: { id: "sess-1", slug: "s", title: "T" },
          };
        },
      });
      const mgr = new AgentManager({ client });

      await mgr.createAgent(workspacePath, { label: "test-label" });

      expect(capturedParams).toEqual({
        directory: workspacePath,
        title: "test-label",
      });
    });
  });

  describe("listAgents", () => {
    it("returns empty array when no agents exist", async () => {
      const agents = await manager.listAgents(workspacePath);
      expect(agents).toEqual([]);
    });

    it("lists all created agents", async () => {
      await manager.createAgent(workspacePath, { label: "agent-a" });
      await manager.createAgent(workspacePath, { label: "agent-b" });

      const agents = await manager.listAgents(workspacePath);
      expect(agents).toHaveLength(2);

      const labels = agents.map((a) => a.label).sort();
      expect(labels).toEqual(["agent-a", "agent-b"]);
    });
  });

  describe("getAgent", () => {
    it("returns agent metadata for existing agent", async () => {
      const created = await manager.createAgent(workspacePath, {
        label: "finder-test",
      });

      const found = await manager.getAgent(workspacePath, created.agentId);
      expect(found.agentId).toBe(created.agentId);
      expect(found.label).toBe("finder-test");
      expect(found.sessionId).toBe("session-abc-123");
    });

    it("throws AGENT_NOT_FOUND for missing agent", async () => {
      try {
        await manager.getAgent(workspacePath, "agent-nonexist");
        expect(true).toBe(false); // should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(OrchestrationError);
        expect((error as OrchestrationError).code).toBe("AGENT_NOT_FOUND");
      }
    });
  });

  describe("removeAgent", () => {
    it("deletes agent metadata and conversation files", async () => {
      const agent = await manager.createAgent(workspacePath, {
        label: "to-remove",
      });

      // Send a message so conversation file exists
      await manager.sendMessage(workspacePath, agent.agentId, "hello");

      // Verify files exist before removal
      const metaPath = path.join(
        workspacePath,
        ".workspace",
        "opencode",
        "agents",
        `${agent.agentId}.json`,
      );
      const convPath = path.join(
        workspacePath,
        ".workspace",
        "opencode",
        "conversations",
        `${agent.agentId}.json`,
      );
      expect(await Bun.file(metaPath).exists()).toBe(true);
      expect(await Bun.file(convPath).exists()).toBe(true);

      await manager.removeAgent(workspacePath, agent.agentId);

      expect(await Bun.file(metaPath).exists()).toBe(false);
      expect(await Bun.file(convPath).exists()).toBe(false);
    });

    it("calls client.session.delete with the session ID", async () => {
      let deletedSessionId: string | undefined;
      const client = createMockClient({
        delete: async (params) => {
          deletedSessionId = params.path.id;
        },
      });
      const mgr = new AgentManager({ client });

      const agent = await mgr.createAgent(workspacePath, {
        label: "delete-test",
      });
      await mgr.removeAgent(workspacePath, agent.agentId);

      expect(deletedSessionId).toBe("session-abc-123");
    });

    it("throws AGENT_NOT_FOUND when removing non-existent agent", async () => {
      try {
        await manager.removeAgent(workspacePath, "agent-nope1234");
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(OrchestrationError);
        expect((error as OrchestrationError).code).toBe("AGENT_NOT_FOUND");
      }
    });
  });

  describe("sendMessage", () => {
    it("sends a prompt and returns the assistant message", async () => {
      const agent = await manager.createAgent(workspacePath, {
        label: "chat-agent",
      });

      const response = await manager.sendMessage(
        workspacePath,
        agent.agentId,
        "What is 2+2?",
      );

      expect(response.role).toBe("assistant");
      expect(response.content).toBe("Hello from the assistant!");
      expect(response.tokens).toEqual({ input: 10, output: 20 });
      expect(response.cost).toBe(0.001);
      expect(response.parts).toEqual([
        { type: "text", text: "Hello from the assistant!" },
      ]);
    });

    it("appends both user and assistant messages to conversation", async () => {
      const agent = await manager.createAgent(workspacePath, {
        label: "persist-agent",
      });

      await manager.sendMessage(workspacePath, agent.agentId, "First message");
      await manager.sendMessage(workspacePath, agent.agentId, "Second message");

      const conversation = await manager.getConversation(
        workspacePath,
        agent.agentId,
      );

      expect(conversation.messages).toHaveLength(4);
      expect(conversation.messages[0].role).toBe("user");
      expect(conversation.messages[0].content).toBe("First message");
      expect(conversation.messages[1].role).toBe("assistant");
      expect(conversation.messages[2].role).toBe("user");
      expect(conversation.messages[2].content).toBe("Second message");
      expect(conversation.messages[3].role).toBe("assistant");
    });

    it("calls client.session.prompt with correct params", async () => {
      let capturedParams: unknown;
      const client = createMockClient({
        prompt: async (params) => {
          capturedParams = params;
          return {
            data: {
              info: { id: "m1", role: "assistant" },
              parts: [{ type: "text", text: "ok" }],
            },
          };
        },
      });
      const mgr = new AgentManager({ client });
      const agent = await mgr.createAgent(workspacePath, {
        label: "prompt-test",
      });

      await mgr.sendMessage(workspacePath, agent.agentId, "test prompt");

      expect(capturedParams).toEqual({
        path: { id: "session-abc-123" },
        body: {
          parts: [{ type: "text", text: "test prompt" }],
        },
      });
    });

    it("handles response with multiple text parts", async () => {
      const client = createMockClient({
        prompt: async () => ({
          data: {
            info: { id: "m1", role: "assistant" },
            parts: [
              { type: "text", text: "Part one. " },
              { type: "tool", toolId: "t1" },
              { type: "text", text: "Part two." },
            ],
          },
        }),
      });
      const mgr = new AgentManager({ client });
      const agent = await mgr.createAgent(workspacePath, {
        label: "multi-part",
      });

      const response = await mgr.sendMessage(
        workspacePath,
        agent.agentId,
        "question",
      );

      expect(response.content).toBe("Part one. Part two.");
    });

    it("handles empty response data", async () => {
      const client = createMockClient({
        prompt: async () => ({ data: undefined }),
      });
      const mgr = new AgentManager({ client });
      const agent = await mgr.createAgent(workspacePath, {
        label: "empty-response",
      });

      const response = await mgr.sendMessage(
        workspacePath,
        agent.agentId,
        "hello",
      );

      expect(response.content).toBe("");
      expect(response.parts).toEqual([]);
    });
  });

  describe("getConversation", () => {
    it("returns empty conversation for new agent", async () => {
      const agent = await manager.createAgent(workspacePath, {
        label: "no-messages",
      });

      const conversation = await manager.getConversation(
        workspacePath,
        agent.agentId,
      );

      expect(conversation.agentId).toBe(agent.agentId);
      expect(conversation.sessionId).toBe("session-abc-123");
      expect(conversation.messages).toEqual([]);
    });

    it("returns full history after multiple messages", async () => {
      const agent = await manager.createAgent(workspacePath, {
        label: "history-agent",
      });

      await manager.sendMessage(workspacePath, agent.agentId, "msg-1");
      await manager.sendMessage(workspacePath, agent.agentId, "msg-2");
      await manager.sendMessage(workspacePath, agent.agentId, "msg-3");

      const conversation = await manager.getConversation(
        workspacePath,
        agent.agentId,
      );

      expect(conversation.messages).toHaveLength(6); // 3 user + 3 assistant
      expect(conversation.messages.filter((m) => m.role === "user")).toHaveLength(3);
      expect(conversation.messages.filter((m) => m.role === "assistant")).toHaveLength(3);
    });

    it("throws AGENT_NOT_FOUND for missing agent", async () => {
      try {
        await manager.getConversation(workspacePath, "agent-nonexist");
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(OrchestrationError);
        expect((error as OrchestrationError).code).toBe("AGENT_NOT_FOUND");
      }
    });
  });
});
