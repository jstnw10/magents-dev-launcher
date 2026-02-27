import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenCodeServer } from "./opencode-server";
import { createOpenCodeClient } from "./opencode-client";
import { AgentManager } from "./agent-manager";
import { detectOpencodePath } from "./opencode-resolver";

const SKIP_E2E = process.env.SKIP_E2E === "1";

// Auto-detect if opencode is installed (for CI environments where it's not)
let opencodeAvailable = false;
if (!SKIP_E2E) {
  try {
    opencodeAvailable = (await detectOpencodePath()) !== null;
  } catch {
    opencodeAvailable = false;
  }
}

async function findFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  return port;
}

describe.skipIf(SKIP_E2E || !opencodeAvailable)("E2E: OpenCode integration", () => {
  let workspacePath: string;
  let server: OpenCodeServer;
  let serverInfo: { pid: number; port: number; url: string };

  beforeAll(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "magents-e2e-"));
    const port = await findFreePort();
    server = new OpenCodeServer({
      timeout: 30_000,
      allocatePort: async () => port,
    });
    serverInfo = await server.start(workspacePath);
  }, 30_000);

  afterAll(async () => {
    if (server && workspacePath) {
      await server.stop(workspacePath);
    }
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
    }
  }, 15_000);

  it("server is running after start", async () => {
    const status = await server.status(workspacePath);
    expect(status.running).toBe(true);
    expect(status.info?.pid).toBe(serverInfo.pid);
    expect(status.info?.port).toBe(serverInfo.port);
  });

  it("raw HTTP session create and delete", async () => {
    // Create session
    const createRes = await fetch(`${serverInfo.url}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(createRes.ok).toBe(true);
    const session = (await createRes.json()) as { id: string; slug: string };
    expect(session.id).toBeTruthy();
    expect(typeof session.id).toBe("string");

    // Delete session
    const deleteRes = await fetch(
      `${serverInfo.url}/session/${session.id}`,
      { method: "DELETE" },
    );
    expect(deleteRes.ok).toBe(true);
  });

  it("opencode-client creates and deletes a session", async () => {
    const client = createOpenCodeClient(serverInfo.url);

    const result = await client.session.create({
      directory: workspacePath,
      title: "client-test",
    });
    expect(result.data.id).toBeTruthy();
    expect(typeof result.data.id).toBe("string");

    // Clean up
    await client.session.delete({ path: { id: result.data.id } });
  });

  it(
    "AgentManager full roundtrip",
    async () => {
      const client = createOpenCodeClient(serverInfo.url);
      const manager = new AgentManager({ client });

      // Create agent
      const agent = await manager.createAgent(workspacePath, {
        label: "e2e-test-agent",
      });
      expect(agent.agentId).toMatch(/^agent-[a-f0-9]{8}$/);
      expect(agent.sessionId).toBeTruthy();
      expect(agent.label).toBe("e2e-test-agent");

      // Send message and verify AI response
      const response = await manager.sendMessage(
        workspacePath,
        agent.agentId,
        "What is 2 + 2? Reply with just the number.",
      );
      expect(response.role).toBe("assistant");
      expect(response.content.length).toBeGreaterThan(0);
      expect(response.content).toContain("4");

      // Verify conversation has 2 messages (user + assistant)
      const conversation = await manager.getConversation(
        workspacePath,
        agent.agentId,
      );
      expect(conversation.messages).toHaveLength(2);
      expect(conversation.messages[0]!.role).toBe("user");
      expect(conversation.messages[1]!.role).toBe("assistant");

      // Verify conversation file exists on disk
      const convFile = Bun.file(
        join(
          workspacePath,
          ".workspace",
          "opencode",
          "conversations",
          `${agent.agentId}.json`,
        ),
      );
      expect(await convFile.exists()).toBe(true);

      // Clean up
      await manager.removeAgent(workspacePath, agent.agentId);

      // Verify cleanup (use fresh Bun.file references to avoid cached state)
      expect(
        await Bun.file(
          join(workspacePath, ".workspace", "opencode", "agents", `${agent.agentId}.json`),
        ).exists(),
      ).toBe(false);
      expect(
        await Bun.file(
          join(workspacePath, ".workspace", "opencode", "conversations", `${agent.agentId}.json`),
        ).exists(),
      ).toBe(false);
    },
    60_000,
  );

  it(
    "multiple agents have independent conversations",
    async () => {
      const client = createOpenCodeClient(serverInfo.url);
      const manager = new AgentManager({ client });

      // Create two agents
      const agent1 = await manager.createAgent(workspacePath, {
        label: "agent-alpha",
      });
      const agent2 = await manager.createAgent(workspacePath, {
        label: "agent-beta",
      });

      // Send different prompts to each (sequentially to avoid rate limits)
      const resp1 = await manager.sendMessage(
        workspacePath,
        agent1.agentId,
        "What is 10 + 5? Reply with just the number.",
      );
      const resp2 = await manager.sendMessage(
        workspacePath,
        agent2.agentId,
        "What is 3 * 7? Reply with just the number.",
      );

      // Verify independent responses
      expect(resp1.content).toContain("15");
      expect(resp2.content).toContain("21");

      // Verify independent conversation histories
      const conv1 = await manager.getConversation(
        workspacePath,
        agent1.agentId,
      );
      const conv2 = await manager.getConversation(
        workspacePath,
        agent2.agentId,
      );
      expect(conv1.messages).toHaveLength(2);
      expect(conv2.messages).toHaveLength(2);
      expect(conv1.sessionId).not.toBe(conv2.sessionId);
      expect(conv1.messages[0]!.content).toContain("10 + 5");
      expect(conv2.messages[0]!.content).toContain("3 * 7");

      // Clean up
      await manager.removeAgent(workspacePath, agent1.agentId);
      await manager.removeAgent(workspacePath, agent2.agentId);
    },
    120_000,
  );
}, 180_000);
