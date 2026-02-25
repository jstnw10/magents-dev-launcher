import { ConvexHttpClient } from "convex/browser";
import type { WorkspaceConfig, WorkspaceStatus } from "./types";

export interface ConvexWorkspaceSyncOptions {
  convexUrl: string;
  enabled?: boolean;
}

export interface SyncWorkspaceExtra {
  tunnelUrl?: string;
  metroPort?: number;
  sessionId?: string;
  packageManager?: string;
}

export class ConvexWorkspaceSync {
  private readonly client: ConvexHttpClient | null;
  private readonly enabled: boolean;

  constructor(options: ConvexWorkspaceSyncOptions) {
    this.enabled = options.enabled ?? true;
    this.client = this.enabled ? new ConvexHttpClient(options.convexUrl) : null;
  }

  async syncWorkspace(
    config: WorkspaceConfig,
    extra?: SyncWorkspaceExtra,
  ): Promise<void> {
    if (!this.enabled || !this.client) return;

    try {
      await this.client.mutation("workspaces:upsert" as any, {
        id: config.id,
        title: config.title,
        branch: config.branch,
        baseRef: config.baseRef,
        baseCommitSha: config.baseCommitSha,
        status: config.status,
        repositoryPath: config.repositoryPath,
        repositoryOwner: config.repositoryOwner,
        repositoryName: config.repositoryName,
        worktreePath: config.worktreePath,
        path: config.path,
        tunnelUrl: extra?.tunnelUrl,
        metroPort: extra?.metroPort,
        sessionId: extra?.sessionId,
        tags: config.tags,
        archived: config.archived,
        archivedAt: config.archivedAt,
        packageManager: extra?.packageManager,
      });
    } catch (err) {
      console.warn("[convex-sync] Failed to sync workspace:", err);
    }
  }

  async syncStatus(
    workspaceId: string,
    status: WorkspaceStatus,
  ): Promise<void> {
    if (!this.enabled || !this.client) return;

    try {
      await this.client.mutation("workspaces:updateStatus" as any, {
        id: workspaceId,
        status,
      });
    } catch (err) {
      console.warn("[convex-sync] Failed to sync status:", err);
    }
  }

  async syncTunnel(
    workspaceId: string,
    tunnelUrl: string | null,
    metroPort?: number,
    sessionId?: string,
  ): Promise<void> {
    if (!this.enabled || !this.client) return;

    try {
      const args: Record<string, unknown> = { id: workspaceId };
      if (tunnelUrl !== null) args.tunnelUrl = tunnelUrl;
      if (metroPort !== undefined) args.metroPort = metroPort;
      if (sessionId !== undefined) args.sessionId = sessionId;

      await this.client.mutation("workspaces:updateTunnel" as any, args);
    } catch (err) {
      console.warn("[convex-sync] Failed to sync tunnel:", err);
    }
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    if (!this.enabled || !this.client) return;

    try {
      await this.client.mutation("workspaces:remove" as any, {
        id: workspaceId,
      });
    } catch (err) {
      console.warn("[convex-sync] Failed to remove workspace:", err);
    }
  }
}
