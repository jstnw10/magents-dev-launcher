import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MagentsMcpServer } from "./server";
import { registerTerminalTools } from "./terminal-tools";

function parseToolResult(result: { content: unknown }): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

async function setupClientAndServer(workspacePath: string) {
  const server = new MagentsMcpServer(workspacePath);
  server.registerTools([registerTerminalTools]);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    client.connect(clientTransport),
    server.mcpServer.connect(serverTransport),
  ]);

  return { client, server };
}

describe("terminal-tools", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realpath(
      await mkdtemp(join(tmpdir(), "magents-term-test-")),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("list_terminals", () => {
    it("returns active terminals", async () => {
      const terminalsDir = join(tmpDir, ".workspace", "terminals");
      await mkdir(terminalsDir, { recursive: true });

      // Use current process PID (known alive)
      await Bun.write(
        join(terminalsDir, "term-1.json"),
        JSON.stringify({
          id: "term-1",
          pid: process.pid,
          cwd: "/tmp",
          name: "Test Terminal",
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "list_terminals",
        arguments: {},
      });
      const parsed = parseToolResult(result);

      expect(parsed.count).toBe(1);
      const terminals = parsed.terminals as Array<Record<string, unknown>>;
      expect(terminals[0].id).toBe("term-1");
      expect(terminals[0].name).toBe("Test Terminal");
      expect(terminals[0].pid).toBe(process.pid);
      expect(terminals[0].cwd).toBe("/tmp");
      expect(terminals[0].isExecutingCommand).toBe(false);

      await client.close();
      await server.mcpServer.close();
    });

    it("filters out dead PIDs", async () => {
      const terminalsDir = join(tmpDir, ".workspace", "terminals");
      await mkdir(terminalsDir, { recursive: true });

      // Alive terminal
      await Bun.write(
        join(terminalsDir, "alive.json"),
        JSON.stringify({
          id: "alive",
          pid: process.pid,
          cwd: "/tmp",
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      // Dead terminal (very large PID)
      await Bun.write(
        join(terminalsDir, "dead.json"),
        JSON.stringify({
          id: "dead",
          pid: 999999999,
          cwd: "/tmp",
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "list_terminals",
        arguments: {},
      });
      const parsed = parseToolResult(result);

      expect(parsed.count).toBe(1);
      const terminals = parsed.terminals as Array<Record<string, unknown>>;
      expect(terminals[0].id).toBe("alive");

      await client.close();
      await server.mcpServer.close();
    });

    it("returns empty when no terminals directory", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "list_terminals",
        arguments: {},
      });
      const parsed = parseToolResult(result);

      expect(parsed.terminals).toEqual([]);
      expect(parsed.message).toBe("No active terminals");

      await client.close();
      await server.mcpServer.close();
    });

    it("returns empty when terminals directory is empty", async () => {
      const terminalsDir = join(tmpDir, ".workspace", "terminals");
      await mkdir(terminalsDir, { recursive: true });

      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "list_terminals",
        arguments: {},
      });
      const parsed = parseToolResult(result);

      expect(parsed.terminals).toEqual([]);
      expect(parsed.message).toBe("No active terminals");

      await client.close();
      await server.mcpServer.close();
    });
  });

  describe("read_terminal_output", () => {
    it("returns last N lines", async () => {
      const terminalsDir = join(tmpDir, ".workspace", "terminals");
      await mkdir(terminalsDir, { recursive: true });

      const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
      await Bun.write(join(terminalsDir, "term-a.log"), lines.join("\n"));

      // Also write terminal metadata
      await Bun.write(
        join(terminalsDir, "term-a.json"),
        JSON.stringify({
          id: "term-a",
          pid: process.pid,
          cwd: "/tmp",
          name: "Output Test",
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "read_terminal_output",
        arguments: { terminal_id: "term-a", max_lines: 10 },
      });
      const parsed = parseToolResult(result);

      expect(parsed.totalLines).toBe(50);
      expect(parsed.returnedLines).toBe(10);
      const output = parsed.output as string;
      expect(output).toContain("line 41");
      expect(output).toContain("line 50");
      expect(output).not.toContain("line 40");

      await client.close();
      await server.mcpServer.close();
    });

    it("strips ANSI codes", async () => {
      const terminalsDir = join(tmpDir, ".workspace", "terminals");
      await mkdir(terminalsDir, { recursive: true });

      await Bun.write(
        join(terminalsDir, "ansi.log"),
        "\x1b[32mgreen text\x1b[0m\n\x1b[1mbold text\x1b[0m\n",
      );

      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "read_terminal_output",
        arguments: { terminal_id: "ansi" },
      });
      const parsed = parseToolResult(result);

      const output = parsed.output as string;
      expect(output).toContain("green text");
      expect(output).toContain("bold text");
      expect(output).not.toContain("\x1b[");

      await client.close();
      await server.mcpServer.close();
    });

    it("errors on nonexistent terminal", async () => {
      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "read_terminal_output",
        arguments: { terminal_id: "nonexistent" },
      });
      const parsed = parseToolResult(result);

      expect(parsed.error).toBeDefined();
      expect((parsed.error as string)).toContain("not found");

      await client.close();
      await server.mcpServer.close();
    });

    it("handles empty log file", async () => {
      const terminalsDir = join(tmpDir, ".workspace", "terminals");
      await mkdir(terminalsDir, { recursive: true });

      await Bun.write(join(terminalsDir, "empty.log"), "");

      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "read_terminal_output",
        arguments: { terminal_id: "empty" },
      });
      const parsed = parseToolResult(result);

      expect(parsed.terminal_id).toBe("empty");
      expect(parsed.totalLines).toBe(1); // Empty string split by \n gives [""]
      expect(parsed.output).toBe("");

      await client.close();
      await server.mcpServer.close();
    });

    it("defaults to 200 lines when max_lines not specified", async () => {
      const terminalsDir = join(tmpDir, ".workspace", "terminals");
      await mkdir(terminalsDir, { recursive: true });

      const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
      await Bun.write(join(terminalsDir, "big.log"), lines.join("\n"));

      const { client, server } = await setupClientAndServer(tmpDir);

      const result = await client.callTool({
        name: "read_terminal_output",
        arguments: { terminal_id: "big" },
      });
      const parsed = parseToolResult(result);

      expect(parsed.totalLines).toBe(300);
      expect(parsed.returnedLines).toBe(200);

      await client.close();
      await server.mcpServer.close();
    });
  });
});
