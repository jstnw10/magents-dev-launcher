import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceConfig, PackageManager } from "./types";

const ADJECTIVES = [
  "agile", "bold", "brave", "bright", "calm",
  "clever", "cool", "daring", "eager", "fair",
  "fast", "fierce", "fond", "frank", "fresh",
  "gentle", "glad", "grand", "happy", "hardy",
  "hasty", "honest", "jolly", "keen", "kind",
  "lively", "loyal", "merry", "mighty", "modest",
  "noble", "plain", "plucky", "polite", "proud",
  "quick", "quiet", "rapid", "ready", "sharp",
  "sleek", "smart", "snug", "steady", "stout",
  "sunny", "swift", "tender", "usual", "vivid",
];

const ANIMALS = [
  "alpaca", "badger", "bobcat", "bison", "canary",
  "condor", "cougar", "crane", "dingo", "eagle",
  "falcon", "ferret", "finch", "fox", "gecko",
  "gibbon", "heron", "hornet", "husky", "ibis",
  "iguana", "jackal", "jaguar", "koala", "lemur",
  "leopon", "lizard", "lynx", "macaw", "marten",
  "mink", "moose", "newt", "ocelot", "otter",
  "parrot", "pelican", "puma", "quail", "raven",
  "robin", "salmon", "shark", "shrew", "sloth",
  "spider", "stork", "tiger", "toucan", "wombat",
];

export function getWorkspacesRoot(): string {
  return process.env.MAGENTS_WORKSPACES_ROOT ?? path.join(Bun.env.HOME ?? "/tmp", ".magents", "workspaces");
}

export function generateWorkspaceId(existingIds?: Set<string>): string {
  const maxAttempts = ADJECTIVES.length * ANIMALS.length;
  for (let i = 0; i < maxAttempts; i++) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const id = `${adj}-${animal}`;
    if (!existingIds || !existingIds.has(id)) {
      return id;
    }
  }
  // Fallback: append a short random suffix
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${adj}-${animal}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function readWorkspaceConfig(workspacePath: string): Promise<WorkspaceConfig> {
  const configPath = path.join(workspacePath, ".workspace", "workspace.json");
  return await Bun.file(configPath).json() as WorkspaceConfig;
}

export async function writeWorkspaceConfig(workspacePath: string, config: WorkspaceConfig): Promise<void> {
  const dotWorkspace = path.join(workspacePath, ".workspace");
  await mkdir(dotWorkspace, { recursive: true });
  const configPath = path.join(dotWorkspace, "workspace.json");
  await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n");
}

export async function initWorkspaceDir(workspacePath: string): Promise<void> {
  const dotWorkspace = path.join(workspacePath, ".workspace");
  await mkdir(path.join(dotWorkspace, "logs"), { recursive: true });
}

export async function listWorkspaces(): Promise<WorkspaceConfig[]> {
  const root = getWorkspacesRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const configs: WorkspaceConfig[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry);
    // Each workspace ID dir may contain repo-name subdirs
    let subEntries: string[];
    try {
      subEntries = await readdir(entryPath);
    } catch {
      continue;
    }
    for (const sub of subEntries) {
      const wsPath = path.join(entryPath, sub);
      try {
        const config = await readWorkspaceConfig(wsPath);
        configs.push(config);
      } catch {
        // Skip directories without valid workspace.json
      }
    }
  }
  return configs;
}

export async function detectPackageManager(repoPath: string): Promise<PackageManager> {
  const lockFiles: Array<[string, PackageManager]> = [
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];

  for (const [lockFile, pm] of lockFiles) {
    if (await Bun.file(path.join(repoPath, lockFile)).exists()) {
      return pm;
    }
  }
  return "npm";
}

export function getDefaultSetupScript(packageManager: PackageManager): string {
  switch (packageManager) {
    case "bun":
      return "bun install";
    case "pnpm":
      return "pnpm install";
    case "yarn":
      return "yarn install";
    case "npm":
      return "npm install";
  }
}
