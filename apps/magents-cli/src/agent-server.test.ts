import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { AgentServer, type AgentServerInfo } from "./agent-server";
import { AgentManager, type OpenCodeClientInterface, type AgentMetadata } from "./agent-manager";

// --- Mock Client ---

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
          info: { id: "msg-1", role: "assistant", tokens: { input: 10, output: 20 }, cost: 0.001 },
          parts: [{ type: "text", text: "Hello from the assistant!" }],
        },
      }),
      messages: async () => ({
        data: [
          { info: { id: "msg-0", role: "user", time: { created: 1000 } }, parts: [{ type: "text", text: "Hi" }] },
          { info: { id: "msg-1", role: "assistant", time: { created: 1001 } }, parts: [{ type: "text", text: "Hello!" }] },
        ],
      }),
      delete: async () => {},
      ...overrides,
    },
  };
}

function tmpWorkspace(): string {
  return path.join(tmpdir(), `agent-server-test-${Bun.randomUUIDv7().slice(0, 8)}`);
}

// Use a random port to avoid conflicts between test runs
function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

describe("AgentServer", () => {
  let workspacePath: string;
  let manager: AgentManager;
  let server: AgentServer;
  let serverInfo: AgentServerInfo;
  let port: number;

  beforeEach(async () => {
    workspacePath = tmpWorkspace();
    port = randomPort();
    manager = new AgentManager({ client: createMockClient() });
    server = new AgentServer({
      workspacePath,
      manager,
      openCodeUrl: "http://127.0.0.1:4096", // Fake OpenCode URL
      port,
    });
    serverInfo = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(workspacePath, { recursive: true, force: true });
  });

  describe("start/stop", () => {
    it("starts on the configured port", () => {
      expect(serverInfo.port).toBe(port);
      expect(serverInfo.url).toBe(`http://127.0.0.1:${port}`);
      expect(serverInfo.startedAt).toBeTruthy();
    });

    it("writes server.json to .workspace/agent-manager/", async () => {
      const infoPath = path.join(workspacePath, ".workspace", "agent-manager", "server.json");
      const file = Bun.file(infoPath);
      expect(await file.exists()).toBe(true);
      const info = await file.json();
      expect(info.port).toBe(port);
    });

    it("removes server.json on stop", async () => {
      await server.stop();
      const infoPath = path.join(workspacePath, ".workspace", "agent-manager", "server.json");
      const file = Bun.file(infoPath);
      expect(await file.exists()).toBe(false);
      // Re-start for afterEach cleanup
      serverInfo = await server.start();
    });
  });

  describe("HTTP endpoints", () => {
    it("POST /agent creates an agent", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "test-agent" }),
      });
      expect(res.status).toBe(201);
      const data = await res.json() as AgentMetadata;
      expect(data.agentId).toMatch(/^agent-/);
      expect(data.label).toBe("test-agent");
      expect(data.sessionId).toBe("session-abc-123");
    });

    it("POST /agent returns 400 without label", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("GET /agent lists agents", async () => {
      // Create an agent first
      await fetch(`http://127.0.0.1:${port}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "list-test" }),
      });

      const res = await fetch(`http://127.0.0.1:${port}/agent`);
      expect(res.status).toBe(200);
      const data = await res.json() as { agents: AgentMetadata[] };
      expect(data.agents.length).toBeGreaterThanOrEqual(1);
      expect(data.agents.some((a: AgentMetadata) => a.label === "list-test")).toBe(true);
    });

    it("GET /agent/:id returns agent metadata", async () => {
      const createRes = await fetch(`http://127.0.0.1:${port}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "get-test" }),
      });
      const created = await createRes.json() as AgentMetadata;

      const res = await fetch(`http://127.0.0.1:${port}/agent/${created.agentId}`);
      expect(res.status).toBe(200);
      const data = await res.json() as AgentMetadata;
      expect(data.agentId).toBe(created.agentId);
      expect(data.label).toBe("get-test");
    });

    it("GET /agent/:id returns 404 for unknown agent", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/agent/agent-nonexist`);
      expect(res.status).toBe(404);
    });

    it("DELETE /agent/:id removes an agent", async () => {
      const createRes = await fetch(`http://127.0.0.1:${port}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "delete-test" }),
      });
      const created = await createRes.json() as AgentMetadata;

      const deleteRes = await fetch(`http://127.0.0.1:${port}/agent/${created.agentId}`, {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(200);
      const data = await deleteRes.json() as { removed: boolean; agentId: string };
      expect(data.removed).toBe(true);

      // Verify it's gone
      const getRes = await fetch(`http://127.0.0.1:${port}/agent/${created.agentId}`);
      expect(getRes.status).toBe(404);
    });

    it("GET /agent/:id/conversation returns conversation", async () => {
      const createRes = await fetch(`http://127.0.0.1:${port}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "conv-test" }),
      });
      const created = await createRes.json() as AgentMetadata;

      const res = await fetch(`http://127.0.0.1:${port}/agent/${created.agentId}/conversation`);
      expect(res.status).toBe(200);
      const data = await res.json() as { agentId: string; messages: unknown[] };
      expect(data.agentId).toBe(created.agentId);
      expect(data.messages).toEqual([]);
    });

    it("returns 404 for unknown routes", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/unknown`);
      expect(res.status).toBe(404);
    });
  });

  describe("WebSocket", () => {
    it("connects to /agent/:id via WebSocket", async () => {
      const createRes = await fetch(`http://127.0.0.1:${port}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "ws-test" }),
      });
      const created = await createRes.json() as AgentMetadata;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/${created.agentId}`);

      const opened = await new Promise<boolean>((resolve) => {
        ws.onopen = () => resolve(true);
        ws.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 2000);
      });

      expect(opened).toBe(true);
      ws.close();
    });

    it("returns error for invalid JSON", async () => {
      const createRes = await fetch(`http://127.0.0.1:${port}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "ws-json-test" }),
      });
      const created = await createRes.json() as AgentMetadata;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/${created.agentId}`);

      const errorMsg = await new Promise<string>((resolve) => {
        ws.onopen = () => {
          ws.send("not json");
        };
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data as string);
          resolve(data.type);
        };
        setTimeout(() => resolve("timeout"), 2000);
      });

      expect(errorMsg).toBe("error");
      ws.close();
    });

    it("returns error for unknown message type", async () => {
      const createRes = await fetch(`http://127.0.0.1:${port}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "ws-unknown-test" }),
      });
      const created = await createRes.json() as AgentMetadata;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/${created.agentId}`);

      const errorMsg = await new Promise<string>((resolve) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "unknown_type" }));
        };
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data as string);
          resolve(data.message);
        };
        setTimeout(() => resolve("timeout"), 2000);
      });

      expect(errorMsg).toContain("Unknown message type");
      ws.close();
    });
  });

  describe("specialist prompt injection", () => {
    it("creates agent with systemPrompt and it persists", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "specialist-test",
          specialistId: "implementor",
          systemPrompt: "You are an implementor specialist.",
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json() as AgentMetadata;
      expect(data.specialistId).toBe("implementor");
      expect(data.systemPrompt).toBe("You are an implementor specialist.");

      // Verify via GET
      const getRes = await fetch(`http://127.0.0.1:${port}/agent/${data.agentId}`);
      const agent = await getRes.json() as AgentMetadata;
      expect(agent.systemPrompt).toBe("You are an implementor specialist.");
    });
  });
});

