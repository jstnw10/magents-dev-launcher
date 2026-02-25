import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  generateWorkspaceId,
  getWorkspacesRoot,
  readWorkspaceConfig,
  writeWorkspaceConfig,
  initWorkspaceDir,
  listWorkspaces,
  detectPackageManager,
  getDefaultSetupScript,
} from "./workspace-config";

import type { WorkspaceConfig } from "./types";

function makeConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    id: "test-workspace",
    title: "Test Workspace",
    branch: "test-workspace",
    baseRef: "main",
    baseCommitSha: "abc123",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    path: "/tmp/test",
    repositoryPath: "/tmp/repo",
    worktreePath: "/tmp/test/repo",
    tags: [],
    ...overrides,
  };
}

describe("generateWorkspaceId", () => {
  it("produces adjective-animal format", () => {
    const id = generateWorkspaceId();
    expect(id).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("produces unique IDs across multiple calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(generateWorkspaceId());
    }
    // With 50 adjectives * 50 animals = 2500 combinations, 50 calls should be mostly unique
    expect(ids.size).toBeGreaterThan(30);
  });

  it("avoids existing IDs", () => {
    const existing = new Set(["bold-fox", "calm-eagle"]);
    const id = generateWorkspaceId(existing);
    expect(existing.has(id)).toBe(false);
  });

  it("falls back with suffix when pool is exhausted", () => {
    // Create a set with all possible combinations
    const existing = new Set<string>();
    const adjectives = [
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
    const animals = [
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
    for (const adj of adjectives) {
      for (const animal of animals) {
        existing.add(`${adj}-${animal}`);
      }
    }
    const id = generateWorkspaceId(existing);
    // Fallback adds a random suffix, so it should have 3 parts
    expect(id.split("-").length).toBe(3);
  });
});

describe("getWorkspacesRoot", () => {
  const originalEnv = process.env.MAGENTS_WORKSPACES_ROOT;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MAGENTS_WORKSPACES_ROOT;
    } else {
      process.env.MAGENTS_WORKSPACES_ROOT = originalEnv;
    }
  });

  it("returns default path when env var is not set", () => {
    delete process.env.MAGENTS_WORKSPACES_ROOT;
    const root = getWorkspacesRoot();
    expect(root).toBe(path.join(os.homedir(), ".magents", "workspaces"));
  });

  it("respects MAGENTS_WORKSPACES_ROOT env var", () => {
    process.env.MAGENTS_WORKSPACES_ROOT = "/custom/workspaces";
    expect(getWorkspacesRoot()).toBe("/custom/workspaces");
  });
});

describe("readWorkspaceConfig / writeWorkspaceConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "ws-config-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("roundtrips a workspace config", async () => {
    const config = makeConfig({ path: tmpDir });
    await writeWorkspaceConfig(tmpDir, config);
    const loaded = await readWorkspaceConfig(tmpDir);
    expect(loaded).toEqual(config);
  });

  it("creates .workspace directory if missing", async () => {
    const config = makeConfig({ path: tmpDir });
    await writeWorkspaceConfig(tmpDir, config);
    const raw = await readFile(path.join(tmpDir, ".workspace", "workspace.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual(config);
  });

  it("throws for missing workspace.json", async () => {
    await expect(readWorkspaceConfig(tmpDir)).rejects.toThrow();
  });
});

describe("initWorkspaceDir", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "ws-init-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates .workspace/logs directory", async () => {
    await initWorkspaceDir(tmpDir);
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path.join(tmpDir, ".workspace"));
    expect(entries).toContain("logs");
  });
});

describe("listWorkspaces", () => {
  let tmpDir: string;
  const originalEnv = process.env.MAGENTS_WORKSPACES_ROOT;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "ws-list-test-"));
    process.env.MAGENTS_WORKSPACES_ROOT = tmpDir;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.MAGENTS_WORKSPACES_ROOT;
    } else {
      process.env.MAGENTS_WORKSPACES_ROOT = originalEnv;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when root does not exist", async () => {
    process.env.MAGENTS_WORKSPACES_ROOT = path.join(tmpDir, "nonexistent");
    const result = await listWorkspaces();
    expect(result).toEqual([]);
  });

  it("discovers workspaces in id/repo-name structure", async () => {
    const ws1Path = path.join(tmpDir, "bold-fox", "my-repo");
    const ws2Path = path.join(tmpDir, "calm-eagle", "my-repo");

    const config1 = makeConfig({ id: "bold-fox", path: ws1Path });
    const config2 = makeConfig({ id: "calm-eagle", path: ws2Path });

    await mkdir(path.join(ws1Path, ".workspace"), { recursive: true });
    await writeFile(
      path.join(ws1Path, ".workspace", "workspace.json"),
      JSON.stringify(config1, null, 2),
    );

    await mkdir(path.join(ws2Path, ".workspace"), { recursive: true });
    await writeFile(
      path.join(ws2Path, ".workspace", "workspace.json"),
      JSON.stringify(config2, null, 2),
    );

    const result = await listWorkspaces();
    expect(result).toHaveLength(2);
    const ids = result.map((c) => c.id).sort();
    expect(ids).toEqual(["bold-fox", "calm-eagle"]);
  });

  it("skips directories without workspace.json", async () => {
    await mkdir(path.join(tmpDir, "broken-dir", "no-config"), { recursive: true });
    const result = await listWorkspaces();
    expect(result).toEqual([]);
  });
});

describe("detectPackageManager", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "ws-pm-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("detects bun via bun.lockb", async () => {
    await writeFile(path.join(tmpDir, "bun.lockb"), "");
    expect(await detectPackageManager(tmpDir)).toBe("bun");
  });

  it("detects bun via bun.lock", async () => {
    await writeFile(path.join(tmpDir, "bun.lock"), "");
    expect(await detectPackageManager(tmpDir)).toBe("bun");
  });

  it("detects pnpm via pnpm-lock.yaml", async () => {
    await writeFile(path.join(tmpDir, "pnpm-lock.yaml"), "");
    expect(await detectPackageManager(tmpDir)).toBe("pnpm");
  });

  it("detects yarn via yarn.lock", async () => {
    await writeFile(path.join(tmpDir, "yarn.lock"), "");
    expect(await detectPackageManager(tmpDir)).toBe("yarn");
  });

  it("detects npm via package-lock.json", async () => {
    await writeFile(path.join(tmpDir, "package-lock.json"), "");
    expect(await detectPackageManager(tmpDir)).toBe("npm");
  });

  it("defaults to npm when no lock file is found", async () => {
    expect(await detectPackageManager(tmpDir)).toBe("npm");
  });

  it("prefers bun over pnpm when both present", async () => {
    await writeFile(path.join(tmpDir, "bun.lockb"), "");
    await writeFile(path.join(tmpDir, "pnpm-lock.yaml"), "");
    expect(await detectPackageManager(tmpDir)).toBe("bun");
  });

  it("prefers pnpm over yarn when both present", async () => {
    await writeFile(path.join(tmpDir, "pnpm-lock.yaml"), "");
    await writeFile(path.join(tmpDir, "yarn.lock"), "");
    expect(await detectPackageManager(tmpDir)).toBe("pnpm");
  });
});

describe("getDefaultSetupScript", () => {
  it("returns correct commands for each package manager", () => {
    expect(getDefaultSetupScript("bun")).toBe("bun install");
    expect(getDefaultSetupScript("pnpm")).toBe("pnpm install");
    expect(getDefaultSetupScript("yarn")).toBe("yarn install");
    expect(getDefaultSetupScript("npm")).toBe("npm install");
  });
});
