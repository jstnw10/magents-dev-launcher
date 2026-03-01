import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { AgentServer, type AgentServerInfo } from "./agent-server";
import { AgentManager, type OpenCodeClientInterface, type AgentMetadata } from "./agent-manager";

// --- Mock OpenCode SSE Server ---

/**
 * Creates a mock OpenCode server that handles POST /session/:id/message
 * and GET /event (SSE stream). Returns SSE events that simulate an assistant response.
 */
function createMockOpenCodeServer(options?: {
  responseText?: string;
  sessionId?: string;
}): { server: ReturnType<typeof Bun.serve>; port: number; url: string; close: () => void } {
  const responseText = options?.responseText ?? "Hello from the assistant!";
  const expectedSessionId = options?.sessionId ?? "session-abc-123";
  let sseController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let messagePosted = false;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      // POST /session/:id/message — triggers SSE events
      if (req.method === "POST" && url.pathname.match(/^\/session\/[^/]+\/message$/)) {
        messagePosted = true;
        // Send SSE events after a short delay
        setTimeout(() => {
          if (!sseController) return;
          const encoder = new TextEncoder();
          const msgId = "msg-asst-1";
          const partId = "part-1";

          // message.updated (start)
          sseController.enqueue(encoder.encode(
            `event: message.updated\ndata: ${JSON.stringify({
              type: "message.updated",
              properties: {
                info: { id: msgId, role: "assistant", sessionID: expectedSessionId },
              },
            })}\n\n`,
          ));

          // message.part.delta
          sseController.enqueue(encoder.encode(
            `event: message.part.delta\ndata: ${JSON.stringify({
              type: "message.part.delta",
              properties: {
                messageID: msgId,
                partID: partId,
                field: "text",
                delta: responseText,
              },
            })}\n\n`,
          ));

          // message.updated (complete)
          sseController.enqueue(encoder.encode(
            `event: message.updated\ndata: ${JSON.stringify({
              type: "message.updated",
              properties: {
                info: {
                  id: msgId,
                  role: "assistant",
                  sessionID: expectedSessionId,
                  time: { completed: Date.now() },
                  tokens: { input: 10, output: 20 },
                  cost: 0.001,
                },
              },
            })}\n\n`,
          ));
        }, 50);

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // GET /event — SSE stream
      if (req.method === "GET" && url.pathname === "/event") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            sseController = controller;
          },
          cancel() {
            sseController = null;
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return {
    server,
    port: server.port,
    url: `http://127.0.0.1:${server.port}`,
    close: () => server.stop(true),
  };
}

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

  describe("WebSocket message flow", () => {
    let mockOC: ReturnType<typeof createMockOpenCodeServer>;
    let flowServer: AgentServer;
    let flowPort: number;
    let flowWorkspace: string;

    beforeEach(async () => {
      mockOC = createMockOpenCodeServer();
      flowWorkspace = tmpWorkspace();
      flowPort = randomPort();
      const flowManager = new AgentManager({ client: createMockClient() });
      flowServer = new AgentServer({
        workspacePath: flowWorkspace,
        manager: flowManager,
        openCodeUrl: mockOC.url,
        port: flowPort,
      });
      await flowServer.start();
    });

    afterEach(async () => {
      await flowServer.stop();
      mockOC.close();
      await rm(flowWorkspace, { recursive: true, force: true });
    });

    it("sends message and receives response frames via WebSocket", async () => {
      // Create agent
      const createRes = await fetch(`http://127.0.0.1:${flowPort}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "ws-flow-test" }),
      });
      const created = await createRes.json() as AgentMetadata;

      // Connect WebSocket
      const ws = new WebSocket(`ws://127.0.0.1:${flowPort}/agent/${created.agentId}`);

      const frames: Array<Record<string, unknown>> = [];
      const done = new Promise<void>((resolve) => {
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data as string);
          frames.push(data);
          if (data.type === "message.complete") {
            resolve();
          }
        };
        setTimeout(() => resolve(), 5000);
      });

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
        setTimeout(() => resolve(), 2000);
      });

      // Send message
      ws.send(JSON.stringify({ type: "message", text: "Hello" }));

      await done;
      ws.close();

      // Verify we received the expected frame types
      const frameTypes = frames.map((f) => f.type);
      expect(frameTypes).toContain("message.start");
      expect(frameTypes).toContain("delta");
      expect(frameTypes).toContain("message.complete");

      // Verify delta contains the response text
      const deltaFrame = frames.find((f) => f.type === "delta");
      expect(deltaFrame?.delta).toBe("Hello from the assistant!");

      // Verify message.complete has tokens/cost
      const completeFrame = frames.find((f) => f.type === "message.complete");
      expect(completeFrame?.tokens).toEqual({ input: 10, output: 20 });
      expect(completeFrame?.cost).toBe(0.001);
    }, 10_000);

    it("writes conversation to disk after message completes", async () => {
      // Create agent
      const createRes = await fetch(`http://127.0.0.1:${flowPort}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "ws-conv-log-test" }),
      });
      const created = await createRes.json() as AgentMetadata;

      // Connect WebSocket and send message
      const ws = new WebSocket(`ws://127.0.0.1:${flowPort}/agent/${created.agentId}`);

      const done = new Promise<void>((resolve) => {
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data as string);
          if (data.type === "message.complete") {
            // Wait a bit for the async log to complete
            setTimeout(() => resolve(), 200);
          }
        };
        setTimeout(() => resolve(), 5000);
      });

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
        setTimeout(() => resolve(), 2000);
      });

      ws.send(JSON.stringify({ type: "message", text: "Test conversation logging" }));
      await done;
      ws.close();

      // Verify conversation file was written
      const convPath = path.join(flowWorkspace, ".workspace", "agents", `${created.agentId}.json`);
      const convFile = Bun.file(convPath);
      expect(await convFile.exists()).toBe(true);

      const conv = await convFile.json();
      expect(conv.id).toBe(created.agentId);
      expect(conv.messages.length).toBe(2);
      expect(conv.messages[0].role).toBe("user");
      expect(conv.messages[0].contentBlocks[0].text).toBe("Test conversation logging");
      expect(conv.messages[1].role).toBe("assistant");
      expect(conv.messages[1].contentBlocks.length).toBeGreaterThan(0);
    }, 10_000);

    it("includes synthetic specialist prompt part when agent has systemPrompt", async () => {
      // We need to capture what gets POSTed to the mock OpenCode server
      let capturedBody: Record<string, unknown> | null = null;
      const captureServer = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          const url = new URL(req.url);
          if (req.method === "POST" && url.pathname.match(/^\/session\/[^/]+\/message$/)) {
            capturedBody = await req.json() as Record<string, unknown>;
            return new Response(JSON.stringify({ ok: true }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          if (req.method === "GET" && url.pathname === "/event") {
            // Return an SSE stream that never sends events (we just need to capture the POST)
            const stream = new ReadableStream<Uint8Array>({
              start() {},
            });
            return new Response(stream, {
              headers: { "Content-Type": "text/event-stream" },
            });
          }
          return new Response("Not found", { status: 404 });
        },
      });

      const captureWorkspace = tmpWorkspace();
      const capturePort = randomPort();
      const captureManager = new AgentManager({ client: createMockClient() });
      const captureAgentServer = new AgentServer({
        workspacePath: captureWorkspace,
        manager: captureManager,
        openCodeUrl: `http://127.0.0.1:${captureServer.port}`,
        port: capturePort,
      });
      await captureAgentServer.start();

      try {
        // Create agent with systemPrompt
        const createRes = await fetch(`http://127.0.0.1:${capturePort}/agent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: "specialist-ws-test",
            specialistId: "implementor",
            systemPrompt: "You are an implementor specialist.",
          }),
        });
        const created = await createRes.json() as AgentMetadata;

        // Connect WebSocket
        const ws = new WebSocket(`ws://127.0.0.1:${capturePort}/agent/${created.agentId}`);
        await new Promise<void>((resolve) => {
          ws.onopen = () => resolve();
          setTimeout(() => resolve(), 2000);
        });

        // Send message
        ws.send(JSON.stringify({ type: "message", text: "Do the task" }));

        // Wait for the POST to be captured
        await new Promise<void>((resolve) => {
          const check = () => {
            if (capturedBody) resolve();
            else setTimeout(check, 50);
          };
          check();
          setTimeout(() => resolve(), 3000);
        });

        ws.close();

        // Verify the POST body includes the synthetic part
        expect(capturedBody).not.toBeNull();
        const parts = (capturedBody as Record<string, unknown>).parts as Array<Record<string, unknown>>;
        expect(parts.length).toBe(2);

        // First part should be synthetic with the specialist prompt wrapped in task-loop template
        expect(parts[0]!.synthetic).toBe(true);
        expect(typeof parts[0]!.text).toBe("string");
        expect((parts[0]!.text as string)).toContain("You are an implementor specialist.");

        // Second part should be the user message
        expect(parts[1]!.text).toBe("Do the task");
        expect(parts[1]!.synthetic).toBeUndefined();
      } finally {
        await captureAgentServer.stop();
        captureServer.stop(true);
        await rm(captureWorkspace, { recursive: true, force: true });
      }
    }, 10_000);
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

