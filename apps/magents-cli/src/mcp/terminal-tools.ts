import { z } from "zod";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "./types.js";
import { sanitizeId } from "./utils.js";

interface TerminalSession {
  id: string;
  pid: number;
  cwd: string;
  name?: string;
  startedAt: string;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function registerTerminalTools(
  server: McpServer,
  context: ToolContext,
): void {
  const terminalsDir = join(context.workspacePath, ".workspace", "terminals");

  // --- list_terminals ---
  server.tool(
    "list_terminals",
    "List active terminal sessions in the workspace. Validates PIDs are still running.",
    {},
    async () => {
      let entries: string[];
      try {
        entries = await readdir(terminalsDir);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                terminals: [],
                message: "No active terminals",
              }),
            },
          ],
        };
      }

      const jsonFiles = entries.filter(
        (e) => e.endsWith(".json"),
      );

      if (jsonFiles.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                terminals: [],
                message: "No active terminals",
              }),
            },
          ],
        };
      }

      const activeTerminals: Array<{
        id: string;
        name: string | null;
        cwd: string;
        pid: number;
        isExecutingCommand: boolean;
        startedAt: string;
      }> = [];

      for (const file of jsonFiles) {
        const filePath = join(terminalsDir, file);
        try {
          const data = JSON.parse(
            await Bun.file(filePath).text(),
          ) as TerminalSession;

          if (isPidAlive(data.pid)) {
            activeTerminals.push({
              id: data.id,
              name: data.name ?? null,
              cwd: data.cwd,
              pid: data.pid,
              isExecutingCommand: false,
              startedAt: data.startedAt,
            });
          }
        } catch {
          // Skip malformed files
        }
      }

      if (activeTerminals.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                terminals: [],
                message: "No active terminals",
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              terminals: activeTerminals,
              count: activeTerminals.length,
            }),
          },
        ],
      };
    },
  );

  // --- read_terminal_output ---
  server.tool(
    "read_terminal_output",
    "Read output from a terminal session. Strips ANSI escape codes and returns the last N lines.",
    {
      terminal_id: z.string().describe("The terminal session ID"),
      max_lines: z
        .number()
        .optional()
        .describe("Maximum lines to return (default 200, max 10000)"),
    },
    async ({ terminal_id, max_lines }) => {
      const safeTerminalId = sanitizeId(terminal_id);
      const logPath = join(terminalsDir, `${safeTerminalId}.log`);
      const logFile = Bun.file(logPath);

      if (!(await logFile.exists())) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Terminal output not found for "${terminal_id}"`,
              }),
            },
          ],
          isError: true,
        };
      }

      const raw = await logFile.text();
      const cleaned = Bun.stripANSI(raw);
      const allLines = cleaned.split("\n");

      const limit = Math.min(Math.max(max_lines ?? 200, 1), 10000);
      const lines =
        allLines.length > limit
          ? allLines.slice(allLines.length - limit)
          : allLines;

      // Read terminal metadata if available
      let terminalInfo: TerminalSession | null = null;
      const metaPath = join(terminalsDir, `${safeTerminalId}.json`);
      const metaFile = Bun.file(metaPath);
      if (await metaFile.exists()) {
        try {
          terminalInfo = JSON.parse(await metaFile.text()) as TerminalSession;
        } catch {
          // ignore
        }
      }

      const header = terminalInfo
        ? `Terminal: ${terminalInfo.name ?? terminalInfo.id} (PID ${terminalInfo.pid}, cwd: ${terminalInfo.cwd})`
        : `Terminal: ${terminal_id}`;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              terminal_id,
              header,
              totalLines: allLines.length,
              returnedLines: lines.length,
              output: lines.join("\n"),
            }),
          },
        ],
      };
    },
  );
}
