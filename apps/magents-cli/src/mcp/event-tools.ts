import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "./types.js";
import {
  readEvents,
  getRecentFiles,
  getAgentActivity,
  getWorkspaceSummary,
  getDirectoryChanges,
  queryEvents,
} from "./event-storage.js";

export function registerEventTools(
  server: McpServer,
  context: ToolContext,
): void {
  // --- read_timeline ---
  server.tool(
    "read_timeline",
    "Read recent workspace events from the timeline log. Optionally filter by event type.",
    {
      limit: z
        .number()
        .optional()
        .describe("Maximum number of events to return (default: 50)"),
      type: z
        .string()
        .optional()
        .describe("Filter by event type (e.g. 'file:changed', 'agent:idle')"),
    },
    async ({ limit, type }) => {
      const events = await readEvents(context.workspacePath, limit ?? 50);
      const filtered = type
        ? events.filter((e) => e.type === type)
        : events;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ events: filtered, count: filtered.length }),
          },
        ],
      };
    },
  );

  // --- get_recent_files ---
  server.tool(
    "get_recent_files",
    "Get recently modified files in the workspace based on git history.",
    {
      limit: z
        .number()
        .optional()
        .describe("Maximum number of files to return (default: 10)"),
    },
    async ({ limit }) => {
      const files = await getRecentFiles(
        context.workspacePath,
        limit ?? 10,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ files, count: files.length }),
          },
        ],
      };
    },
  );

  // --- get_agent_activity ---
  server.tool(
    "get_agent_activity",
    "Get recent agent activity by scanning agent metadata files.",
    {
      minutesAgo: z
        .number()
        .optional()
        .describe("How many minutes back to look (default: 30)"),
      agentId: z
        .string()
        .optional()
        .describe("Filter by specific agent ID"),
    },
    async ({ minutesAgo, agentId }) => {
      const agents = await getAgentActivity(
        context.workspacePath,
        minutesAgo ?? 30,
        agentId,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ agents, count: agents.length }),
          },
        ],
      };
    },
  );

  // --- get_workspace_summary ---
  server.tool(
    "get_workspace_summary",
    "Get a comprehensive summary of workspace activity including events, agents, files, and git status.",
    {
      minutesAgo: z
        .number()
        .optional()
        .describe("How many minutes back to look (default: 60)"),
    },
    async ({ minutesAgo }) => {
      const summary = await getWorkspaceSummary(
        context.workspacePath,
        minutesAgo ?? 60,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(summary),
          },
        ],
      };
    },
  );

  // --- get_directory_changes ---
  server.tool(
    "get_directory_changes",
    "Get recent changes to files in a specific directory based on git history.",
    {
      directory: z.string().describe("Directory path to check for changes"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of changes to return (default: 20)"),
    },
    async ({ directory, limit }) => {
      const changes = await getDirectoryChanges(
        context.workspacePath,
        directory,
        limit ?? 20,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ changes, count: changes.length }),
          },
        ],
      };
    },
  );

  // --- query_events ---
  server.tool(
    "query_events",
    "Query workspace events with advanced filters. All filters are optional.",
    {
      eventType: z
        .string()
        .optional()
        .describe("Filter by event type (e.g. 'file:changed')"),
      actorType: z
        .string()
        .optional()
        .describe("Filter by actor type ('user', 'agent', 'system')"),
      actorId: z
        .string()
        .optional()
        .describe("Filter by specific actor ID"),
      path: z
        .string()
        .optional()
        .describe("Filter by file/directory path (prefix match)"),
      minutesAgo: z
        .number()
        .optional()
        .describe("Filter events from the last N minutes"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of events to return (default: 50)"),
    },
    async ({ eventType, actorType, actorId, path, minutesAgo, limit }) => {
      const events = await queryEvents(context.workspacePath, {
        eventType,
        actorType,
        actorId,
        path,
        minutesAgo,
        limit: limit ?? 50,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ events, count: events.length }),
          },
        ],
      };
    },
  );
}
