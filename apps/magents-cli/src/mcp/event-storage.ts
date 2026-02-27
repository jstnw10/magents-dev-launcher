import { join } from "node:path";
import { mkdir, readdir } from "node:fs/promises";

export interface WorkspaceEvent {
  id: string;
  type: string; // e.g. "file:changed", "agent:idle", "command:executed"
  timestamp: string; // ISO 8601
  actor: {
    type: "user" | "agent" | "system";
    id?: string;
  };
  data: Record<string, unknown>;
}

export interface EventFilters {
  eventType?: string;
  actorType?: string;
  actorId?: string;
  path?: string; // prefix match on data.path
  minutesAgo?: number;
  limit?: number;
}

export function getEventsFilePath(workspacePath: string): string {
  return join(workspacePath, ".workspace", "events.jsonl");
}

export async function appendEvent(
  workspacePath: string,
  event: Omit<WorkspaceEvent, "id" | "timestamp">,
): Promise<WorkspaceEvent> {
  const filePath = getEventsFilePath(workspacePath);
  const dir = join(workspacePath, ".workspace");
  await mkdir(dir, { recursive: true });

  const full: WorkspaceEvent = {
    ...event,
    id: Bun.randomUUIDv7(),
    timestamp: new Date().toISOString(),
  };

  const line = JSON.stringify(full) + "\n";

  const file = Bun.file(filePath);
  let existing = "";
  if (await file.exists()) {
    existing = await file.text();
  }

  await Bun.write(filePath, existing + line);
  return full;
}

export async function readEvents(
  workspacePath: string,
  limit?: number,
): Promise<WorkspaceEvent[]> {
  const filePath = getEventsFilePath(workspacePath);
  const file = Bun.file(filePath);

  if (!(await file.exists())) return [];

  const text = await file.text();
  const events: WorkspaceEvent[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    events.push(JSON.parse(line) as WorkspaceEvent);
  }

  if (limit !== undefined && limit > 0) {
    return events.slice(-limit);
  }

  return events;
}

export async function queryEvents(
  workspacePath: string,
  filters: EventFilters,
): Promise<WorkspaceEvent[]> {
  const all = await readEvents(workspacePath);

  let filtered = all;

  if (filters.eventType) {
    filtered = filtered.filter((e) => e.type === filters.eventType);
  }

  if (filters.actorType) {
    filtered = filtered.filter((e) => e.actor.type === filters.actorType);
  }

  if (filters.actorId) {
    filtered = filtered.filter((e) => e.actor.id === filters.actorId);
  }

  if (filters.path) {
    const prefix = filters.path;
    filtered = filtered.filter(
      (e) => typeof e.data.path === "string" && (e.data.path as string).startsWith(prefix),
    );
  }

  if (filters.minutesAgo !== undefined && filters.minutesAgo > 0) {
    const cutoff = new Date(Date.now() - filters.minutesAgo * 60 * 1000).toISOString();
    filtered = filtered.filter((e) => e.timestamp >= cutoff);
  }

  if (filters.limit !== undefined && filters.limit > 0) {
    filtered = filtered.slice(-filters.limit);
  }

  return filtered;
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

export async function getRecentFiles(
  workspacePath: string,
  limit: number = 10,
): Promise<Array<{ path: string; lastModified: string }>> {
  const { stdout, exitCode } = await runGit(
    ["log", "--all", "--diff-filter=AMCR", "--name-only", "--pretty=format:%ai", "-n", "50"],
    workspacePath,
  );

  if (exitCode !== 0 || !stdout.trim()) return [];

  const seen = new Map<string, string>();
  let currentDate = "";

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;

    // Date lines match pattern: YYYY-MM-DD HH:MM:SS +/-ZZZZ
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(line)) {
      currentDate = line.trim();
    } else if (currentDate && !seen.has(line.trim())) {
      seen.set(line.trim(), currentDate);
    }
  }

  const files = Array.from(seen.entries()).map(([path, lastModified]) => ({
    path,
    lastModified,
  }));

  return files.slice(0, limit);
}

export async function getAgentActivity(
  workspacePath: string,
  minutesAgo: number = 30,
  agentId?: string,
): Promise<Array<{ agentId: string; name?: string; updatedAt: string }>> {
  const agentsDir = join(workspacePath, ".workspace", "opencode", "agents");

  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch {
    return [];
  }

  const cutoff = new Date(Date.now() - minutesAgo * 60 * 1000);
  const results: Array<{ agentId: string; name?: string; updatedAt: string }> = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;

    const filePath = join(agentsDir, entry);
    const file = Bun.file(filePath);
    if (!(await file.exists())) continue;

    const data = JSON.parse(await file.text()) as Record<string, unknown>;
    const updatedAt = data.updatedAt as string | undefined;

    if (!updatedAt) continue;
    if (new Date(updatedAt) < cutoff) continue;

    const id = (data.agentId as string) ?? entry.replace(".json", "");

    if (agentId && id !== agentId) continue;

    results.push({
      agentId: id,
      name: data.name as string | undefined,
      updatedAt,
    });
  }

  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return results;
}

export async function getDirectoryChanges(
  workspacePath: string,
  directory: string,
  limit: number = 20,
): Promise<Array<{ path: string; date: string; action: string }>> {
  const { stdout, exitCode } = await runGit(
    [
      "log",
      "--diff-filter=AMCRD",
      "--name-status",
      "--pretty=format:%ai",
      `-n`,
      String(limit),
      "--",
      directory,
    ],
    workspacePath,
  );

  if (exitCode !== 0 || !stdout.trim()) return [];

  const ACTION_MAP: Record<string, string> = {
    A: "added",
    M: "modified",
    C: "copied",
    R: "renamed",
    D: "deleted",
  };

  const results: Array<{ path: string; date: string; action: string }> = [];
  let currentDate = "";

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;

    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(line)) {
      currentDate = line.trim();
    } else if (currentDate) {
      // Lines like "M\tpath/to/file" or "A\tpath/to/file"
      const match = line.match(/^([AMCRD])\t(.+)$/);
      if (match) {
        results.push({
          path: match[2],
          date: currentDate,
          action: ACTION_MAP[match[1]] ?? match[1],
        });
      }
    }
  }

  return results;
}

export async function getWorkspaceSummary(
  workspacePath: string,
  minutesAgo: number = 60,
): Promise<{
  eventCountsByType: Record<string, number>;
  activeAgentCount: number;
  recentFileCount: number;
  gitStatus: string;
}> {
  // Event counts by type
  const events = await queryEvents(workspacePath, { minutesAgo });
  const eventCountsByType: Record<string, number> = {};
  for (const event of events) {
    eventCountsByType[event.type] = (eventCountsByType[event.type] ?? 0) + 1;
  }

  // Active agent count
  const agents = await getAgentActivity(workspacePath, minutesAgo);
  const activeAgentCount = agents.length;

  // Recent file count
  const recentFiles = await getRecentFiles(workspacePath, 50);
  const recentFileCount = recentFiles.length;

  // Git status summary
  const { stdout: gitStatusOutput } = await runGit(
    ["status", "--porcelain"],
    workspacePath,
  );
  const gitStatus = gitStatusOutput.trim() || "clean";

  return {
    eventCountsByType,
    activeAgentCount,
    recentFileCount,
    gitStatus,
  };
}
