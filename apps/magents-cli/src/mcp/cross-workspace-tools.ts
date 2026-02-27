import { z } from "zod";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "./types.js";
import { listNotes, loadNote } from "./note-storage.js";

interface WorkspaceEntry {
  id: string;
  path: string;
  repoPath: string;
}

interface SiblingWorkspace {
  id: string;
  title: string | null;
  branch: string | null;
  workspacePath: string;
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trimEnd(), exitCode };
}

async function getRepoRoot(cwd: string): Promise<string | null> {
  const { stdout, exitCode } = await runGit(
    ["rev-parse", "--show-toplevel"],
    cwd,
  );
  if (exitCode !== 0) return null;
  return stdout.trim();
}

async function readRegistryFile(
  repoRoot: string,
): Promise<WorkspaceEntry[] | null> {
  const registryPath = join(repoRoot, ".workspace", "registry.json");
  const file = Bun.file(registryPath);
  if (!(await file.exists())) return null;
  try {
    return JSON.parse(await file.text()) as WorkspaceEntry[];
  } catch {
    return null;
  }
}

async function scanForWorkspaces(
  repoRoot: string,
): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = [];

  // Scan up to 2 levels deep for .workspace/metadata.json
  let topLevelDirs: string[];
  try {
    topLevelDirs = await readdir(repoRoot, { withFileTypes: true }).then(
      (dirents) =>
        dirents.filter((d) => d.isDirectory()).map((d) => d.name),
    );
  } catch {
    return entries;
  }

  for (const dir of topLevelDirs) {
    if (dir.startsWith(".")) continue;
    const dirPath = join(repoRoot, dir);

    // Check if this directory itself is a workspace
    const metaFile = Bun.file(join(dirPath, ".workspace", "metadata.json"));
    if (await metaFile.exists()) {
      entries.push({ id: dir, path: dirPath, repoPath: repoRoot });
      continue;
    }

    // Check one level deeper
    let subDirs: string[];
    try {
      subDirs = await readdir(dirPath, { withFileTypes: true }).then(
        (dirents) =>
          dirents.filter((d) => d.isDirectory()).map((d) => d.name),
      );
    } catch {
      continue;
    }

    for (const subDir of subDirs) {
      if (subDir.startsWith(".")) continue;
      const subPath = join(dirPath, subDir);
      const subMetaFile = Bun.file(
        join(subPath, ".workspace", "metadata.json"),
      );
      if (await subMetaFile.exists()) {
        entries.push({
          id: subDir,
          path: subPath,
          repoPath: repoRoot,
        });
      }
    }
  }

  return entries;
}

async function discoverSiblingWorkspaces(
  currentWorkspacePath: string,
): Promise<SiblingWorkspace[]> {
  const repoRoot = await getRepoRoot(currentWorkspacePath);
  if (!repoRoot) return [];

  // Try registry first, then fall back to scanning
  let workspaceEntries = await readRegistryFile(repoRoot);
  if (!workspaceEntries) {
    workspaceEntries = await scanForWorkspaces(repoRoot);
  }

  // Filter to same repo, exclude current workspace
  const siblings = workspaceEntries.filter(
    (entry) => entry.path !== currentWorkspacePath,
  );

  const results: SiblingWorkspace[] = [];
  for (const entry of siblings) {
    // Read title from metadata.json
    let title: string | null = null;
    const metaFile = Bun.file(
      join(entry.path, ".workspace", "metadata.json"),
    );
    if (await metaFile.exists()) {
      try {
        const meta = JSON.parse(await metaFile.text());
        title = meta.title ?? null;
      } catch {
        // ignore parse errors
      }
    }

    // Get branch
    let branch: string | null = null;
    const { stdout, exitCode } = await runGit(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      entry.path,
    );
    if (exitCode === 0) {
      branch = stdout.trim();
    }

    results.push({
      id: entry.id,
      title,
      branch,
      workspacePath: entry.path,
    });
  }

  return results;
}

export function registerCrossWorkspaceTools(
  server: McpServer,
  context: ToolContext,
): void {
  // --- list_sibling_workspaces ---
  server.tool(
    "list_sibling_workspaces",
    "List other workspaces that share the same git repository.",
    {},
    async () => {
      const siblings = await discoverSiblingWorkspaces(
        context.workspacePath,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              workspaces: siblings,
              count: siblings.length,
            }),
          },
        ],
      };
    },
  );

  // --- read_external_note ---
  server.tool(
    "read_external_note",
    "Read a note from a sibling workspace. Validates the target shares the same git repo.",
    {
      targetWorkspaceId: z
        .string()
        .describe("ID of the target sibling workspace"),
      noteId: z.string().describe("ID of the note to read"),
    },
    async ({ targetWorkspaceId, noteId }) => {
      const siblings = await discoverSiblingWorkspaces(
        context.workspacePath,
      );
      const target = siblings.find((s) => s.id === targetWorkspaceId);

      if (!target) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Workspace "${targetWorkspaceId}" not found among sibling workspaces`,
              }),
            },
          ],
          isError: true,
        };
      }

      // Security: verify same repo root
      const currentRepoRoot = await getRepoRoot(context.workspacePath);
      const targetRepoRoot = await getRepoRoot(target.workspacePath);
      if (!currentRepoRoot || !targetRepoRoot || currentRepoRoot !== targetRepoRoot) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Target workspace does not share the same git repository",
              }),
            },
          ],
          isError: true,
        };
      }

      const note = await loadNote(target.workspacePath, noteId);
      if (!note) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Note "${noteId}" not found in workspace "${targetWorkspaceId}"`,
              }),
            },
          ],
          isError: true,
        };
      }

      // Format content with line numbers
      const lines = note.content.split("\n");
      const formatted = lines
        .map((line, i) => {
          const lineNum = String(i + 1).padStart(4, " ");
          return `${lineNum} | ${line}`;
        })
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: note.id,
              title: note.title,
              tags: note.tags,
              sourceWorkspace: {
                id: target.id,
                title: target.title,
              },
              content: formatted,
            }),
          },
        ],
      };
    },
  );

  // --- list_external_notes ---
  server.tool(
    "list_external_notes",
    "List all notes in a sibling workspace.",
    {
      targetWorkspaceId: z
        .string()
        .describe("ID of the target sibling workspace"),
    },
    async ({ targetWorkspaceId }) => {
      const siblings = await discoverSiblingWorkspaces(
        context.workspacePath,
      );
      const target = siblings.find((s) => s.id === targetWorkspaceId);

      if (!target) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Workspace "${targetWorkspaceId}" not found among sibling workspaces`,
              }),
            },
          ],
          isError: true,
        };
      }

      // Security: verify same repo root
      const currentRepoRoot = await getRepoRoot(context.workspacePath);
      const targetRepoRoot = await getRepoRoot(target.workspacePath);
      if (!currentRepoRoot || !targetRepoRoot || currentRepoRoot !== targetRepoRoot) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Target workspace does not share the same git repository",
              }),
            },
          ],
          isError: true,
        };
      }

      const notes = await listNotes(target.workspacePath);
      const noteList = notes.map((n) => ({
        id: n.id,
        title: n.title,
        tags: n.tags,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              notes: noteList,
              count: noteList.length,
              sourceWorkspace: {
                id: target.id,
                title: target.title,
              },
            }),
          },
        ],
      };
    },
  );
}
