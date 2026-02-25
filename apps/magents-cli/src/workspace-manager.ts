import { $ } from "bun";
import path from "node:path";

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

import { OrchestrationError, type WorkspaceConfig, type WorkspaceCreateOptions, type WorkspaceStatus } from "./types";
import type { WorktreeManager } from "./types";
import type { ConvexWorkspaceSync } from "./convex-sync";

export interface WorkspaceManagerOptions {
  readonly worktrees: WorktreeManager;
  readonly workspacesRoot?: string;
  readonly sync?: ConvexWorkspaceSync;
}

export interface WorkspaceCreateResult {
  workspace: WorkspaceConfig;
  setupOutput?: string;
  setupError?: string;
}

export class WorkspaceManager {
  private readonly worktrees: WorktreeManager;
  private readonly workspacesRoot: string;
  private readonly sync?: ConvexWorkspaceSync;

  constructor(options: WorkspaceManagerOptions) {
    this.worktrees = options.worktrees;
    this.workspacesRoot = options.workspacesRoot ?? getWorkspacesRoot();
    this.sync = options.sync;
  }

  async create(options: WorkspaceCreateOptions): Promise<WorkspaceCreateResult> {
    const existingWorkspaces = await listWorkspaces();
    const existingIds = new Set(existingWorkspaces.map((w) => w.id));

    const workspaceId = generateWorkspaceId(existingIds);
    const repoName = path.basename(options.repositoryPath);
    const workspacePath = path.join(this.workspacesRoot, workspaceId, repoName);
    const branch = options.branch ?? workspaceId;
    const baseRef = options.baseRef ?? "main";

    // Resolve the base commit SHA before creating the worktree
    let baseCommitSha: string;
    try {
      const revParseResult = Bun.spawnSync(["git", "rev-parse", baseRef], {
        cwd: options.repositoryPath,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (revParseResult.exitCode !== 0) {
        throw new Error("git rev-parse failed");
      }
      baseCommitSha = revParseResult.stdout.toString().trim();
    } catch {
      throw new OrchestrationError(
        "INVALID_BASE_REF",
        `Could not resolve base ref '${baseRef}' in repository '${options.repositoryPath}'.`,
      );
    }

    // Create the git worktree
    await this.worktrees.provision({
      sessionId: branch,
      sourceRoot: options.repositoryPath,
      requestedPath: workspacePath,
      baseRef,
    });

    // Init workspace directory structure
    await initWorkspaceDir(workspacePath);

    // Build the workspace config
    const now = new Date().toISOString();
    const config: WorkspaceConfig = {
      id: workspaceId,
      title: options.title ?? workspaceId,
      branch,
      baseRef,
      baseCommitSha,
      status: "active",
      createdAt: now,
      updatedAt: now,
      path: workspacePath,
      repositoryPath: options.repositoryPath,
      repositoryName: repoName,
      worktreePath: workspacePath,
      tags: [],
    };

    await writeWorkspaceConfig(workspacePath, config);

    // Run setup script
    const result: WorkspaceCreateResult = { workspace: config };

    const packageManager = await detectPackageManager(workspacePath);
    const setupScript = options.setupScript ?? getDefaultSetupScript(packageManager);

    try {
      const setupResult = Bun.spawnSync(["sh", "-c", setupScript], {
        cwd: workspacePath,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (setupResult.exitCode !== 0) {
        throw new Error(setupResult.stderr.toString());
      }
      result.setupOutput = setupResult.stdout.toString();
    } catch (err) {
      result.setupError = err instanceof Error ? err.message : String(err);
    }

    try {
      await this.sync?.syncWorkspace(config, { packageManager });
    } catch {
      // Sync errors must not block workspace creation
    }

    return result;
  }

  async list(): Promise<WorkspaceConfig[]> {
    return listWorkspaces();
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceConfig> {
    const workspaces = await listWorkspaces();
    const workspace = workspaces.find((w) => w.id === workspaceId);
    if (!workspace) {
      throw new OrchestrationError(
        "WORKSPACE_NOT_FOUND",
        `Workspace '${workspaceId}' was not found.`,
      );
    }
    return workspace;
  }

  async status(workspaceId: string): Promise<WorkspaceConfig> {
    return this.getWorkspace(workspaceId);
  }

  async archive(workspaceId: string): Promise<WorkspaceConfig> {
    const workspace = await this.getWorkspace(workspaceId);

    const now = new Date().toISOString();
    const updated: WorkspaceConfig = {
      ...workspace,
      status: "archived" as WorkspaceStatus,
      archived: true,
      archivedAt: now,
      updatedAt: now,
    };

    await writeWorkspaceConfig(workspace.path, updated);

    try {
      await this.sync?.syncStatus(workspaceId, "archived");
    } catch {
      // Sync errors must not block workspace archival
    }

    return updated;
  }

  async destroy(workspaceId: string, options?: { force?: boolean }): Promise<void> {
    const workspace = await this.getWorkspace(workspaceId);

    // Remove the git worktree
    try {
      await this.worktrees.cleanup({
        sourceRoot: workspace.repositoryPath,
        path: workspace.worktreePath,
        force: options?.force,
      });
    } catch (err) {
      if (
        err instanceof OrchestrationError &&
        err.code === "WORKTREE_DIRTY" &&
        !options?.force
      ) {
        throw err;
      }
      // If the worktree is already gone, continue with directory cleanup
    }

    // Remove the workspace directory (parent of repo-name dir)
    const workspaceDir = path.dirname(workspace.path);
    await $`rm -rf ${workspaceDir}`.quiet();

    try {
      await this.sync?.removeWorkspace(workspaceId);
    } catch {
      // Sync errors must not block workspace destruction
    }
  }
}
