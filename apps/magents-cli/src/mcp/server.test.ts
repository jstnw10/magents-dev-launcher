import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer, MagentsMcpServer } from "./server";

describe("MagentsMcpServer", () => {
  it("can be created with a workspace path", () => {
    const server = new MagentsMcpServer("/test/workspace");
    expect(server).toBeInstanceOf(MagentsMcpServer);
    expect(server.mcpServer).toBeDefined();
  });

  it("registers custom tools via registerTools", () => {
    const server = new MagentsMcpServer("/test/workspace");
    let called = false;
    server.registerTools([
      (mcpServer, context) => {
        called = true;
        expect(context.workspacePath).toBe("/test/workspace");
      },
    ]);
    expect(called).toBe(true);
  });
});

describe("createMcpServer", () => {
  it("creates a server with the ping tool registered", async () => {
    const server = createMcpServer("/test/workspace");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([
      client.connect(clientTransport),
      server.mcpServer.connect(serverTransport),
    ]);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain("ping");

    await client.close();
    await server.mcpServer.close();
  });

  it("ping tool returns status ok with workspace path", async () => {
    const server = createMcpServer("/my/workspace");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([
      client.connect(clientTransport),
      server.mcpServer.connect(serverTransport),
    ]);

    const result = await client.callTool({ name: "ping", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");

    const parsed = JSON.parse(content[0].text);
    expect(parsed.status).toBe("ok");
    expect(parsed.workspacePath).toBe("/my/workspace");

    await client.close();
    await server.mcpServer.close();
  });
});
