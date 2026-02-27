import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import type { ToolContext } from "./types.js";

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return JSON.parse(await file.text());
}

async function writeJsonFile(path: string, data: Record<string, unknown>): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(data, null, 2) + "\n");
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

function registerSetWorkspaceTitle(server: McpServer, context: ToolContext): void {
  server.tool(
    "set_workspace_title",
    "Set or update the workspace title. Also renames the git branch to match.",
    { title: z.string().describe("The workspace title (1-5 words)") },
    async ({ title }) => {
      const metadataPath = join(context.workspacePath, ".workspace", "metadata.json");
      const existing = (await readJsonFile(metadataPath)) ?? {};
      const slug = slugify(title);

      await writeJsonFile(metadataPath, {
        ...existing,
        title,
        updatedAt: new Date().toISOString(),
      });

      let branch = slug;
      let warning: string | undefined;

      const { stdout: currentBranch } = await runGit(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        context.workspacePath,
      );

      if (currentBranch === slug) {
        branch = slug;
      } else {
        const { exitCode } = await runGit(
          ["branch", "-m", slug],
          context.workspacePath,
        );
        if (exitCode !== 0) {
          warning = `Branch rename failed. Current branch is still "${currentBranch}".`;
          branch = currentBranch;
        }
      }

      const result: Record<string, unknown> = { title, branch };
      if (warning) result.warning = warning;

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );
}

function registerGetWorkspaceDetails(server: McpServer, context: ToolContext): void {
  server.tool(
    "get_workspace_details",
    "Get workspace metadata including title, git branch, and paths.",
    {},
    async () => {
      const metadataPath = join(context.workspacePath, ".workspace", "metadata.json");
      const metadata = await readJsonFile(metadataPath);

      const { stdout: branch } = await runGit(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        context.workspacePath,
      );
      const { stdout: repoPath } = await runGit(
        ["rev-parse", "--show-toplevel"],
        context.workspacePath,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              title: metadata?.title ?? null,
              branch,
              repoPath,
              workspacePath: context.workspacePath,
            }),
          },
        ],
      };
    },
  );
}

function registerSetAgentName(server: McpServer, context: ToolContext): void {
  server.tool(
    "set_agent_name",
    "Set or update an agent's display name.",
    {
      agentId: z.string().describe("The agent identifier"),
      name: z.string().describe("Display name for the agent"),
    },
    async ({ agentId, name }) => {
      const agentPath = join(
        context.workspacePath,
        ".workspace",
        "agents",
        `${agentId}.json`,
      );

      const existing = (await readJsonFile(agentPath)) ?? { agentId };

      await writeJsonFile(agentPath, {
        ...existing,
        name,
        updatedAt: new Date().toISOString(),
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ agentId, name }) }],
      };
    },
  );
}

export function registerWorkspaceTools(server: McpServer, context: ToolContext): void {
  registerSetWorkspaceTitle(server, context);
  registerGetWorkspaceDetails(server, context);
  registerSetAgentName(server, context);
}
