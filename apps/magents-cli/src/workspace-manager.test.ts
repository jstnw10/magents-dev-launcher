import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { WorkspaceManager } from "./workspace-manager";
import type { WorktreeInfo, WorktreeManager, WorkspaceConfig } from "./types";

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

class MockWorktreeManager implements WorktreeManager {
  readonly provisionedPaths: string[] = [];
  readonly cleanedPaths: string[] = [];

  async provision(input: {
    sessionId: string;
    sourceRoot: string;
    requestedPath?: string;
    baseRef?: string;
  }): Promise<string> {
    const targetPath = input.requestedPath ?? `${input.sourceRoot}/.magents/${input.sessionId}`;
    this.provisionedPaths.push(targetPath);
    // Simulate git worktree creating the directory
    await mkdir(targetPath, { recursive: true });
    return targetPath;
  }

  async cleanup(input: { sourceRoot: string; path: string; force?: boolean }): Promise<void> {
    this.cleanedPaths.push(input.path);
  }

  async list(_sourceRoot: string): Promise<WorktreeInfo[]> {
    return [];
  }

  async exists(_worktreePath: string): Promise<boolean> {
    return false;
  }
}

describe("WorkspaceManager", () => {
  let tmpDir: string;
  let workspacesRoot: string;
  let repoDir: string;
  let worktrees: MockWorktreeManager;
  let manager: WorkspaceManager;
  const originalEnv = process.env.MAGENTS_WORKSPACES_ROOT;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(Bun.env.TMPDIR ?? "/tmp", "ws-manager-test-"));
    workspacesRoot = path.join(tmpDir, "workspaces");
    repoDir = path.join(tmpDir, "repo");
    await mkdir(workspacesRoot, { recursive: true });
    await mkdir(repoDir, { recursive: true });

    // Initialize a real git repo so git rev-parse works
    // Use Bun.spawnSync to avoid mock.module("node:child_process") pollution from other tests
    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    await writeFile(path.join(repoDir, "README.md"), "# test\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "commit", "-m", "init", "--allow-empty"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });

    // Point listWorkspaces to our temp dir
    process.env.MAGENTS_WORKSPACES_ROOT = workspacesRoot;

    worktrees = new MockWorktreeManager();
    manager = new WorkspaceManager({
      worktrees,
      workspacesRoot,
    });
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.MAGENTS_WORKSPACES_ROOT;
    } else {
      process.env.MAGENTS_WORKSPACES_ROOT = originalEnv;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates workspace with worktree, config, and directory structure", async () => {
      const result = await manager.create({
        repositoryPath: repoDir,
      });

      expect(result.workspace.id).toMatch(/^[a-z]+-[a-z]+$/);
      expect(result.workspace.status).toBe("active");
      expect(result.workspace.repositoryPath).toBe(repoDir);
      expect(result.workspace.branch).toBe(result.workspace.id);
      expect(result.workspace.baseRef).toBe("main");
      expect(result.workspace.tags).toEqual([]);

      // Worktree was provisioned
      expect(worktrees.provisionedPaths).toHaveLength(1);

      // Config was written
      const configPath = path.join(result.workspace.path, ".workspace", "workspace.json");
      const rawConfig = await readFile(configPath, "utf-8");
      const savedConfig = JSON.parse(rawConfig) as WorkspaceConfig;
      expect(savedConfig.id).toBe(result.workspace.id);
    });

    it("uses provided title and baseRef", async () => {
      const result = await manager.create({
        repositoryPath: repoDir,
        title: "My Feature",
        baseRef: "main",
      });

      expect(result.workspace.title).toBe("My Feature");
      expect(result.workspace.baseRef).toBe("main");
    });

    it("captures setup error without failing", async () => {
      const result = await manager.create({
        repositoryPath: repoDir,
        setupScript: "false", // shell command that always fails
      });

      expect(result.workspace).toBeDefined();
      expect(result.setupError).toBeDefined();
    });

    it("generates unique IDs for multiple workspaces", async () => {
      const result1 = await manager.create({ repositoryPath: repoDir });
      const result2 = await manager.create({ repositoryPath: repoDir });

      expect(result1.workspace.id).not.toBe(result2.workspace.id);
    });

    it("uses workspace ID as branch name by default", async () => {
      const result = await manager.create({ repositoryPath: repoDir });
      expect(result.workspace.branch).toBe(result.workspace.id);
    });
  });

  describe("list", () => {
    it("returns empty array when no workspaces exist", async () => {
      const result = await manager.list();
      expect(result).toEqual([]);
    });

    it("returns all workspaces", async () => {
      // Create two workspaces manually
      const ws1Path = path.join(workspacesRoot, "bold-fox", "repo");
      const ws2Path = path.join(workspacesRoot, "calm-eagle", "repo");

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

      const result = await manager.list();
      expect(result).toHaveLength(2);
      const ids = result.map((w) => w.id).sort();
      expect(ids).toEqual(["bold-fox", "calm-eagle"]);
    });
  });

  describe("getWorkspace", () => {
    it("returns workspace by ID", async () => {
      const wsPath = path.join(workspacesRoot, "bold-fox", "repo");
      const config = makeConfig({ id: "bold-fox", path: wsPath });
      await mkdir(path.join(wsPath, ".workspace"), { recursive: true });
      await writeFile(
        path.join(wsPath, ".workspace", "workspace.json"),
        JSON.stringify(config, null, 2),
      );

      const result = await manager.getWorkspace("bold-fox");
      expect(result.id).toBe("bold-fox");
    });

    it("throws WORKSPACE_NOT_FOUND for unknown ID", async () => {
      await expect(manager.getWorkspace("nonexistent")).rejects.toThrow("not found");
    });
  });

  describe("status", () => {
    it("returns workspace config", async () => {
      const wsPath = path.join(workspacesRoot, "bold-fox", "repo");
      const config = makeConfig({ id: "bold-fox", path: wsPath });
      await mkdir(path.join(wsPath, ".workspace"), { recursive: true });
      await writeFile(
        path.join(wsPath, ".workspace", "workspace.json"),
        JSON.stringify(config, null, 2),
      );

      const result = await manager.status("bold-fox");
      expect(result.id).toBe("bold-fox");
      expect(result.status).toBe("active");
    });
  });

  describe("archive", () => {
    it("marks workspace as archived without deleting files", async () => {
      const wsPath = path.join(workspacesRoot, "bold-fox", "repo");
      const config = makeConfig({ id: "bold-fox", path: wsPath });
      await mkdir(path.join(wsPath, ".workspace"), { recursive: true });
      await writeFile(
        path.join(wsPath, ".workspace", "workspace.json"),
        JSON.stringify(config, null, 2),
      );

      const result = await manager.archive("bold-fox");

      expect(result.status).toBe("archived");
      expect(result.archived).toBe(true);
      expect(result.archivedAt).toBeDefined();

      // Config on disk was updated
      const rawConfig = await readFile(
        path.join(wsPath, ".workspace", "workspace.json"),
        "utf-8",
      );
      const savedConfig = JSON.parse(rawConfig) as WorkspaceConfig;
      expect(savedConfig.status).toBe("archived");
      expect(savedConfig.archived).toBe(true);

      // Directory still exists
      const entries = await readdir(path.join(workspacesRoot, "bold-fox"));
      expect(entries).toContain("repo");
    });
  });

  describe("destroy", () => {
    it("removes worktree and workspace directory", async () => {
      const wsPath = path.join(workspacesRoot, "bold-fox", "repo");
      const config = makeConfig({
        id: "bold-fox",
        path: wsPath,
        repositoryPath: repoDir,
        worktreePath: wsPath,
      });
      await mkdir(path.join(wsPath, ".workspace"), { recursive: true });
      await writeFile(
        path.join(wsPath, ".workspace", "workspace.json"),
        JSON.stringify(config, null, 2),
      );

      await manager.destroy("bold-fox");

      // Worktree cleanup was called
      expect(worktrees.cleanedPaths).toContain(wsPath);

      // Directory was removed
      await expect(readdir(path.join(workspacesRoot, "bold-fox"))).rejects.toThrow();
    });

    it("passes force flag to worktree cleanup", async () => {
      const wsPath = path.join(workspacesRoot, "calm-eagle", "repo");
      const config = makeConfig({
        id: "calm-eagle",
        path: wsPath,
        repositoryPath: repoDir,
        worktreePath: wsPath,
      });
      await mkdir(path.join(wsPath, ".workspace"), { recursive: true });
      await writeFile(
        path.join(wsPath, ".workspace", "workspace.json"),
        JSON.stringify(config, null, 2),
      );

      await manager.destroy("calm-eagle", { force: true });
      expect(worktrees.cleanedPaths).toContain(wsPath);
    });

    it("throws WORKSPACE_NOT_FOUND for unknown ID", async () => {
      await expect(manager.destroy("nonexistent")).rejects.toThrow("not found");
    });
  });
});
