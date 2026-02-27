import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { ToolContext } from "./types.js";
import { registerGitTools } from "./git-tools.js";
import { registerWorkspaceTools } from "./workspace-tools.js";

export type ToolRegistration = (server: McpServer, context: ToolContext) => void;

export class MagentsMcpServer {
  readonly mcpServer: McpServer;
  private readonly context: ToolContext;

  constructor(workspacePath: string) {
    this.context = { workspacePath };
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

export function createMcpServer(workspacePath: string): MagentsMcpServer {
  const server = new MagentsMcpServer(workspacePath);
  server.registerTools([registerPingTool, registerGitTools, registerWorkspaceTools]);
  return server;
}
