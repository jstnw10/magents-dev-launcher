import { describe, expect, it, afterEach } from "bun:test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api";
import { ConvexWorkspaceSync } from "./convex-sync";
import type { WorkspaceConfig } from "./types";

const CONVEX_URL = "https://gregarious-aardvark-924.convex.cloud";

// Track all workspace IDs created during tests for cleanup
let createdIds: string[] = [];

function testId(): string {
  const id = `e2e-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createdIds.push(id);
  return id;
}

function makeTestWorkspace(id: string): {
  id: string;
  title: string;
  branch: string;
  baseRef: string;
  baseCommitSha: string;
  status: "active" | "archived";
  repositoryPath: string;
  repositoryOwner: string;
  repositoryName: string;
  worktreePath: string;
  path: string;
  tags: string[];
} {
  return {
    id,
    title: `E2E Test Workspace ${id}`,
    branch: `branch-${id}`,
    baseRef: "main",
    baseCommitSha: "abc123def456",
    status: "active" as const,
    repositoryPath: "/tmp/e2e-repo",
    repositoryOwner: "e2e-owner",
    repositoryName: "e2e-repo",
    worktreePath: `/tmp/e2e-worktree/${id}`,
    path: `/tmp/e2e-workspace/${id}`,
    tags: ["e2e-test"],
  };
}

function makeWorkspaceConfig(id: string): WorkspaceConfig {
  return {
    id,
    title: `E2E Test Workspace ${id}`,
    branch: `branch-${id}`,
    baseRef: "main",
    baseCommitSha: "abc123def456",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    path: `/tmp/e2e-workspace/${id}`,
    repositoryPath: "/tmp/e2e-repo",
    repositoryOwner: "e2e-owner",
    repositoryName: "e2e-repo",
    worktreePath: `/tmp/e2e-worktree/${id}`,
    tags: ["e2e-test"],
  };
}

describe.skipIf(!process.env.RUN_E2E)("Convex workspace e2e tests", () => {
  const client = new ConvexHttpClient(CONVEX_URL);

  afterEach(async () => {
    // Clean up all test workspaces
    for (const id of createdIds) {
      try {
        await client.mutation(api.workspaces.remove, { id });
      } catch {
        // Ignore cleanup errors
      }
    }
    createdIds = [];
  });

  describe("upsert and get", () => {
    it("creates a new workspace and retrieves it with correct fields", async () => {
      const id = testId();
      const ws = makeTestWorkspace(id);

      await client.mutation(api.workspaces.upsert, ws);
      const result = await client.query(api.workspaces.get, { id });

      expect(result).not.toBeNull();
      expect(result!.id).toBe(id);
      expect(result!.title).toBe(`E2E Test Workspace ${id}`);
      expect(result!.status).toBe("active");
      expect(result!.createdAt).toBeGreaterThan(0);
      expect(result!.lastUpdatedAt).toBeGreaterThan(0);
    });

    it("updates an existing workspace on second upsert", async () => {
      const id = testId();
      const ws = makeTestWorkspace(id);

      await client.mutation(api.workspaces.upsert, ws);
      await client.mutation(api.workspaces.upsert, {
        ...ws,
        title: "Updated Title",
      });

      const result = await client.query(api.workspaces.get, { id });
      expect(result).not.toBeNull();
      expect(result!.title).toBe("Updated Title");
    });
  });

  describe("updateStatus", () => {
    it("changes status to archived and sets archived fields", async () => {
      const id = testId();
      await client.mutation(api.workspaces.upsert, makeTestWorkspace(id));

      await client.mutation(api.workspaces.updateStatus, {
        id,
        status: "archived",
      });

      const result = await client.query(api.workspaces.get, { id });
      expect(result).not.toBeNull();
      expect(result!.status).toBe("archived");
      expect(result!.archived).toBe(true);
      expect(result!.archivedAt).toBeDefined();
      expect(typeof result!.archivedAt).toBe("string");
    });

    it("throws for non-existent workspace", async () => {
      const fakeId = testId();
      await expect(
        client.mutation(api.workspaces.updateStatus, {
          id: fakeId,
          status: "archived",
        }),
      ).rejects.toThrow();
    });
  });

  describe("updateTunnel", () => {
    it("sets tunnelUrl, metroPort, and sessionId", async () => {
      const id = testId();
      await client.mutation(api.workspaces.upsert, makeTestWorkspace(id));

      await client.mutation(api.workspaces.updateTunnel, {
        id,
        tunnelUrl: "https://e2e-tunnel.example.com",
        metroPort: 9999,
        sessionId: "e2e-session-123",
      });

      const result = await client.query(api.workspaces.get, { id });
      expect(result).not.toBeNull();
      expect(result!.tunnelUrl).toBe("https://e2e-tunnel.example.com");
      expect(result!.metroPort).toBe(9999);
      expect(result!.sessionId).toBe("e2e-session-123");
    });

    it("throws for non-existent workspace", async () => {
      const fakeId = testId();
      await expect(
        client.mutation(api.workspaces.updateTunnel, {
          id: fakeId,
          tunnelUrl: "https://test.example.com",
        }),
      ).rejects.toThrow();
    });
  });

  describe("remove", () => {
    it("deletes a workspace and subsequent get returns null", async () => {
      const id = testId();
      await client.mutation(api.workspaces.upsert, makeTestWorkspace(id));

      const removed = await client.mutation(api.workspaces.remove, { id });
      expect(removed).toBe(true);

      const result = await client.query(api.workspaces.get, { id });
      expect(result).toBeNull();
    });

    it("returns false for non-existent workspace", async () => {
      const fakeId = testId();
      const result = await client.mutation(api.workspaces.remove, {
        id: fakeId,
      });
      expect(result).toBe(false);
    });
  });

  describe("list and listActive", () => {
    it("list includes the test workspace", async () => {
      const id = testId();
      await client.mutation(api.workspaces.upsert, makeTestWorkspace(id));

      const all = await client.query(api.workspaces.list, {});
      const found = all.find((w: { id: string }) => w.id === id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(id);
    });

    it("listActive excludes archived workspaces", async () => {
      const id = testId();
      await client.mutation(api.workspaces.upsert, makeTestWorkspace(id));
      await client.mutation(api.workspaces.updateStatus, {
        id,
        status: "archived",
      });

      const active = await client.query(api.workspaces.listActive, {});
      const found = active.find((w: { id: string }) => w.id === id);
      expect(found).toBeUndefined();
    });
  });

  describe("ConvexWorkspaceSync class", () => {
    it("syncWorkspace creates a workspace retrievable via direct query", async () => {
      const id = testId();
      const config = makeWorkspaceConfig(id);

      const sync = new ConvexWorkspaceSync({ convexUrl: CONVEX_URL });
      await sync.syncWorkspace(config, { packageManager: "bun" });

      const result = await client.query(api.workspaces.get, { id });
      expect(result).not.toBeNull();
      expect(result!.id).toBe(id);
      expect(result!.title).toBe(config.title);
      expect(result!.packageManager).toBe("bun");
    });

    it("syncStatus archives a workspace", async () => {
      const id = testId();
      const config = makeWorkspaceConfig(id);

      const sync = new ConvexWorkspaceSync({ convexUrl: CONVEX_URL });
      await sync.syncWorkspace(config);
      await sync.syncStatus(id, "archived");

      const result = await client.query(api.workspaces.get, { id });
      expect(result).not.toBeNull();
      expect(result!.status).toBe("archived");
      expect(result!.archived).toBe(true);
    });

    it("removeWorkspace removes a workspace", async () => {
      const id = testId();
      const config = makeWorkspaceConfig(id);

      const sync = new ConvexWorkspaceSync({ convexUrl: CONVEX_URL });
      await sync.syncWorkspace(config);
      await sync.removeWorkspace(id);

      const result = await client.query(api.workspaces.get, { id });
      expect(result).toBeNull();
    });
  });
});
