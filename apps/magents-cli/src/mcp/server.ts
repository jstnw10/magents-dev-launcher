import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { ToolContext } from "./types.js";
import { registerAgentTools } from "./agent-tools.js";
import { registerGitTools } from "./git-tools.js";
import { registerNoteTools } from "./note-tools.js";
import { registerTaskTools } from "./task-tools.js";
import { registerWorkspaceTools } from "./workspace-tools.js";

export type ToolRegistration = (server: McpServer, context: ToolContext) => void;

export class MagentsMcpServer {
  readonly mcpServer: McpServer;
  private readonly context: ToolContext;

  constructor(workspacePath: string, contextOverrides?: Partial<Omit<ToolContext, "workspacePath">>) {
    this.context = { workspacePath, ...contextOverrides };
    this.mcpServer = new McpServer({
      name: "magents-workspace",
      version: "0.1.0",
    });
  }

  registerTools(tools: ToolRegistration[]): void {
    for (const register of tools) {
      register(this.mcpServer, this.context);
    }
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.mcpServer.connect(transport);
  }
}

function registerPingTool(server: McpServer, context: ToolContext): void {
  server.tool("ping", "Health check for the magents MCP server", async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "ok", workspacePath: context.workspacePath }),
        },
      ],
    };
  });
}

export function createMcpServer(
  workspacePath: string,
  contextOverrides?: Partial<Omit<ToolContext, "workspacePath">>,
): MagentsMcpServer {
  const server = new MagentsMcpServer(workspacePath, contextOverrides);
  server.registerTools([
    registerPingTool,
    registerAgentTools,
    registerGitTools,
    registerNoteTools,
    registerTaskTools,
    registerWorkspaceTools,
  ]);
  return server;
}
