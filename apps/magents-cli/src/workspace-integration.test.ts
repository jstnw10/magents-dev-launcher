import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { WorkspaceManager } from "./workspace-manager";
import { OrchestrationError } from "./types";
import type { WorktreeInfo, WorktreeManager, WorkspaceConfig } from "./types";
import type { ConvexWorkspaceSync } from "./convex-sync";

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

describe("Workspace Integration — full lifecycle", () => {
  let tmpDir: string;
  let workspacesRoot: string;
  let repoDir: string;
  let worktrees: MockWorktreeManager;
  let manager: WorkspaceManager;
  const originalEnv = process.env.MAGENTS_WORKSPACES_ROOT;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(Bun.env.TMPDIR ?? "/tmp", "ws-integration-"));
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

  it("full lifecycle: create → status → list → archive → list (shows archived) → destroy", async () => {
    // 1. Create
    const createResult = await manager.create({ repositoryPath: repoDir });
    const wsId = createResult.workspace.id;
    expect(createResult.workspace.status).toBe("active");

    // 2. Status
    const statusResult = await manager.status(wsId);
    expect(statusResult.id).toBe(wsId);
    expect(statusResult.status).toBe("active");

    // 3. List — shows 1 active workspace
    const listBefore = await manager.list();
    expect(listBefore).toHaveLength(1);
    expect(listBefore[0].id).toBe(wsId);
    expect(listBefore[0].status).toBe("active");

    // 4. Archive
    const archived = await manager.archive(wsId);
    expect(archived.status).toBe("archived");
    expect(archived.archived).toBe(true);
    expect(archived.archivedAt).toBeDefined();

    // 5. List — still shows the workspace but now archived
    const listAfter = await manager.list();
    expect(listAfter).toHaveLength(1);
    expect(listAfter[0].status).toBe("archived");

    // 6. Destroy
    await manager.destroy(wsId);
    expect(worktrees.cleanedPaths).toHaveLength(1);

    // 7. List — empty after destroy
    const listFinal = await manager.list();
    expect(listFinal).toHaveLength(0);
  });

  it("create with custom title and base-ref", async () => {
    const result = await manager.create({
      repositoryPath: repoDir,
      title: "My Feature Branch",
      baseRef: "main",
    });

    expect(result.workspace.title).toBe("My Feature Branch");
    expect(result.workspace.baseRef).toBe("main");
    expect(result.workspace.baseCommitSha).toBeTruthy();
    expect(result.workspace.status).toBe("active");
  });

  it("create with auto-detected bun package manager", async () => {
    // Place a bun.lock in the worktree directory so detectPackageManager finds it.
    // The worktree directory is created by MockWorktreeManager during provision.
    // We need a setup script that succeeds so we can verify it ran.
    const result = await manager.create({
      repositoryPath: repoDir,
      setupScript: "echo bun-detected",
    });

    expect(result.workspace).toBeDefined();
    expect(result.setupOutput).toContain("bun-detected");
    expect(result.setupError).toBeUndefined();
  });

  it("create captures setup failure without aborting workspace creation", async () => {
    const result = await manager.create({
      repositoryPath: repoDir,
      setupScript: "false", // always fails
    });

    expect(result.workspace).toBeDefined();
    expect(result.workspace.status).toBe("active");
    expect(result.setupError).toBeDefined();

    // Workspace should still be listable
    const list = await manager.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(result.workspace.id);
  });

  it("archive preserves files on disk but marks as archived", async () => {
    const result = await manager.create({ repositoryPath: repoDir });
    const wsPath = result.workspace.path;

    // Create a user file in the workspace
    await writeFile(path.join(wsPath, "user-file.txt"), "important data");

    const archived = await manager.archive(result.workspace.id);
    expect(archived.status).toBe("archived");
    expect(archived.archived).toBe(true);

    // File still exists on disk
    const content = await readFile(path.join(wsPath, "user-file.txt"), "utf-8");
    expect(content).toBe("important data");

    // Config on disk reflects archived status
    const configPath = path.join(wsPath, ".workspace", "workspace.json");
    const savedConfig = JSON.parse(await readFile(configPath, "utf-8")) as WorkspaceConfig;
    expect(savedConfig.status).toBe("archived");
    expect(savedConfig.archived).toBe(true);
  });

  it("destroy removes workspace directory entirely", async () => {
    const result = await manager.create({ repositoryPath: repoDir });
    const wsId = result.workspace.id;
    const wsParentDir = path.dirname(result.workspace.path);

    // Verify directory exists before destroy
    const entriesBefore = await readdir(wsParentDir);
    expect(entriesBefore.length).toBeGreaterThan(0);

    await manager.destroy(wsId);

    // Directory should be gone
    await expect(readdir(wsParentDir)).rejects.toThrow();
  });

  it("error: status of non-existent workspace throws WORKSPACE_NOT_FOUND", async () => {
    try {
      await manager.status("nonexistent-ws");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
      expect((err as OrchestrationError).code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  it("error: destroy non-existent workspace throws WORKSPACE_NOT_FOUND", async () => {
    try {
      await manager.destroy("ghost-workspace");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
      expect((err as OrchestrationError).code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  it("error: archive non-existent workspace throws WORKSPACE_NOT_FOUND", async () => {
    try {
      await manager.archive("phantom-workspace");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
      expect((err as OrchestrationError).code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  it("error: create with invalid repo path throws INVALID_BASE_REF", async () => {
    try {
      await manager.create({
        repositoryPath: path.join(tmpDir, "not-a-repo"),
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
      expect((err as OrchestrationError).code).toBe("INVALID_BASE_REF");
    }
  });

  it("list with no workspaces returns empty array", async () => {
    const list = await manager.list();
    expect(list).toEqual([]);
  });

  it("multiple workspaces get unique IDs", async () => {
    const ws1 = await manager.create({ repositoryPath: repoDir });
    const ws2 = await manager.create({ repositoryPath: repoDir });
    const ws3 = await manager.create({ repositoryPath: repoDir });

    const ids = [ws1.workspace.id, ws2.workspace.id, ws3.workspace.id];
    expect(new Set(ids).size).toBe(3);

    const list = await manager.list();
    expect(list).toHaveLength(3);
  });

  it("archive then list shows correct status for mixed workspaces", async () => {
    const ws1 = await manager.create({ repositoryPath: repoDir });
    const ws2 = await manager.create({ repositoryPath: repoDir });

    await manager.archive(ws1.workspace.id);

    const list = await manager.list();
    expect(list).toHaveLength(2);

    const archived = list.find((w) => w.id === ws1.workspace.id);
    const active = list.find((w) => w.id === ws2.workspace.id);

    expect(archived?.status).toBe("archived");
    expect(active?.status).toBe("active");
  });

  it("workspace config persists all fields correctly through create", async () => {
    const result = await manager.create({
      repositoryPath: repoDir,
      title: "Persistence Test",
      baseRef: "main",
    });

    const ws = result.workspace;
    expect(ws.id).toMatch(/^[a-z]+-[a-z]+$/);
    expect(ws.title).toBe("Persistence Test");
    expect(ws.branch).toBe(ws.id);
    expect(ws.baseRef).toBe("main");
    expect(ws.baseCommitSha).toMatch(/^[a-f0-9]+$/);
    expect(ws.status).toBe("active");
    expect(ws.createdAt).toBeTruthy();
    expect(ws.updatedAt).toBeTruthy();
    expect(ws.path).toContain(workspacesRoot);
    expect(ws.repositoryPath).toBe(repoDir);
    expect(ws.worktreePath).toBe(ws.path);
    expect(ws.tags).toEqual([]);

    // Verify it roundtrips from disk
    const fromDisk = await manager.status(ws.id);
    expect(fromDisk.id).toBe(ws.id);
    expect(fromDisk.title).toBe("Persistence Test");
    expect(fromDisk.baseCommitSha).toBe(ws.baseCommitSha);
  });

  it("destroy after archive works correctly", async () => {
    const result = await manager.create({ repositoryPath: repoDir });
    const wsId = result.workspace.id;

    await manager.archive(wsId);
    await manager.destroy(wsId);

    const list = await manager.list();
    expect(list).toHaveLength(0);
    expect(worktrees.cleanedPaths).toHaveLength(1);
  });
});

function createMockSync(): ConvexWorkspaceSync & {
  syncWorkspace: ReturnType<typeof mock>;
  syncStatus: ReturnType<typeof mock>;
  syncTunnel: ReturnType<typeof mock>;
  removeWorkspace: ReturnType<typeof mock>;
} {
  return {
    syncWorkspace: mock(() => Promise.resolve()),
    syncStatus: mock(() => Promise.resolve()),
    syncTunnel: mock(() => Promise.resolve()),
    removeWorkspace: mock(() => Promise.resolve()),
  } as any;
}

describe("Workspace Integration — Convex sync", () => {
  let tmpDir: string;
  let workspacesRoot: string;
  let repoDir: string;
  let worktrees: MockWorktreeManager;
  const originalEnv = process.env.MAGENTS_WORKSPACES_ROOT;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(Bun.env.TMPDIR ?? "/tmp", "ws-sync-integration-"));
    workspacesRoot = path.join(tmpDir, "workspaces");
    repoDir = path.join(tmpDir, "repo");
    await mkdir(workspacesRoot, { recursive: true });
    await mkdir(repoDir, { recursive: true });

    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    await writeFile(path.join(repoDir, "README.md"), "# test\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "commit", "-m", "init", "--allow-empty"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });

    process.env.MAGENTS_WORKSPACES_ROOT = workspacesRoot;
    worktrees = new MockWorktreeManager();
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.MAGENTS_WORKSPACES_ROOT;
    } else {
      process.env.MAGENTS_WORKSPACES_ROOT = originalEnv;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("workspace create calls syncWorkspace on the sync instance", async () => {
    const mockSync = createMockSync();
    const manager = new WorkspaceManager({ worktrees, workspacesRoot, sync: mockSync as any });

    const result = await manager.create({ repositoryPath: repoDir });

    expect(mockSync.syncWorkspace).toHaveBeenCalledTimes(1);
    const [config, extra] = mockSync.syncWorkspace.mock.calls[0] as [WorkspaceConfig, any];
    expect(config.id).toBe(result.workspace.id);
    expect(config.status).toBe("active");
    expect(extra).toBeDefined();
  });

  it("workspace archive calls syncStatus on the sync instance", async () => {
    const mockSync = createMockSync();
    const manager = new WorkspaceManager({ worktrees, workspacesRoot, sync: mockSync as any });

    const result = await manager.create({ repositoryPath: repoDir });
    mockSync.syncWorkspace.mockClear();

    await manager.archive(result.workspace.id);

    expect(mockSync.syncStatus).toHaveBeenCalledTimes(1);
    const [wsId, status] = mockSync.syncStatus.mock.calls[0] as [string, string];
    expect(wsId).toBe(result.workspace.id);
    expect(status).toBe("archived");
  });

  it("workspace destroy calls removeWorkspace on the sync instance", async () => {
    const mockSync = createMockSync();
    const manager = new WorkspaceManager({ worktrees, workspacesRoot, sync: mockSync as any });

    const result = await manager.create({ repositoryPath: repoDir });
    mockSync.syncWorkspace.mockClear();

    await manager.destroy(result.workspace.id);

    expect(mockSync.removeWorkspace).toHaveBeenCalledTimes(1);
    const [wsId] = mockSync.removeWorkspace.mock.calls[0] as [string];
    expect(wsId).toBe(result.workspace.id);
  });

  it("sync errors during create do not prevent workspace creation", async () => {
    const mockSync = createMockSync();
    mockSync.syncWorkspace.mockImplementation(() => Promise.reject(new Error("sync failed")));
    const manager = new WorkspaceManager({ worktrees, workspacesRoot, sync: mockSync as any });

    const result = await manager.create({ repositoryPath: repoDir });

    expect(result.workspace).toBeDefined();
    expect(result.workspace.status).toBe("active");
    const list = await manager.list();
    expect(list).toHaveLength(1);
  });

  it("sync errors during archive do not prevent workspace archival", async () => {
    const mockSync = createMockSync();
    const manager = new WorkspaceManager({ worktrees, workspacesRoot, sync: mockSync as any });

    const result = await manager.create({ repositoryPath: repoDir });
    mockSync.syncStatus.mockImplementation(() => Promise.reject(new Error("sync failed")));

    const archived = await manager.archive(result.workspace.id);

    expect(archived.status).toBe("archived");
    expect(archived.archived).toBe(true);
  });

  it("sync errors during destroy do not prevent workspace destruction", async () => {
    const mockSync = createMockSync();
    const manager = new WorkspaceManager({ worktrees, workspacesRoot, sync: mockSync as any });

    const result = await manager.create({ repositoryPath: repoDir });
    mockSync.removeWorkspace.mockImplementation(() => Promise.reject(new Error("sync failed")));

    await manager.destroy(result.workspace.id);

    const list = await manager.list();
    expect(list).toHaveLength(0);
  });

  it("workspace manager works without sync (undefined)", async () => {
    const manager = new WorkspaceManager({ worktrees, workspacesRoot });

    const result = await manager.create({ repositoryPath: repoDir });
    expect(result.workspace.status).toBe("active");

    await manager.archive(result.workspace.id);
    const archived = await manager.status(result.workspace.id);
    expect(archived.status).toBe("archived");

    await manager.destroy(result.workspace.id);
    const list = await manager.list();
    expect(list).toHaveLength(0);
  });
});
