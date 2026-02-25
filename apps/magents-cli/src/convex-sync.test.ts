import { describe, expect, it, beforeEach, mock, spyOn } from "bun:test";
import { ConvexWorkspaceSync, type ConvexWorkspaceSyncOptions } from "./convex-sync";
import type { WorkspaceConfig } from "./types";

// Mock ConvexHttpClient
const mockMutation = mock(() => Promise.resolve());

mock.module("convex/browser", () => ({
  ConvexHttpClient: class {
    constructor(_url: string) {}
    mutation = mockMutation;
  },
}));

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
    repositoryOwner: "test-owner",
    repositoryName: "test-repo",
    worktreePath: "/tmp/test/repo",
    tags: ["dev"],
    ...overrides,
  };
}

describe("ConvexWorkspaceSync", () => {
  beforeEach(() => {
    mockMutation.mockClear();
    mockMutation.mockImplementation(() => Promise.resolve());
  });

  describe("syncWorkspace", () => {
    it("calls upsert mutation with correct arguments", async () => {
      const sync = new ConvexWorkspaceSync({ convexUrl: "https://test.convex.cloud" });
      const config = makeConfig();

      await sync.syncWorkspace(config, { packageManager: "bun", tunnelUrl: "https://tunnel.example.com" });

      expect(mockMutation).toHaveBeenCalledTimes(1);
      const [fnName, args] = mockMutation.mock.calls[0] as [string, Record<string, unknown>];
      expect(fnName).toBe("workspaces:upsert");
      expect(args.id).toBe("test-workspace");
      expect(args.title).toBe("Test Workspace");
      expect(args.branch).toBe("test-workspace");
      expect(args.baseRef).toBe("main");
      expect(args.baseCommitSha).toBe("abc123");
      expect(args.status).toBe("active");
      expect(args.repositoryPath).toBe("/tmp/repo");
      expect(args.repositoryOwner).toBe("test-owner");
      expect(args.repositoryName).toBe("test-repo");
      expect(args.worktreePath).toBe("/tmp/test/repo");
      expect(args.path).toBe("/tmp/test");
      expect(args.tags).toEqual(["dev"]);
      expect(args.packageManager).toBe("bun");
      expect(args.tunnelUrl).toBe("https://tunnel.example.com");
    });

    it("does not throw when mutation fails", async () => {
      mockMutation.mockImplementation(() => Promise.reject(new Error("network error")));
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      const sync = new ConvexWorkspaceSync({ convexUrl: "https://test.convex.cloud" });
      await sync.syncWorkspace(makeConfig());

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("syncStatus", () => {
    it("calls updateStatus mutation with correct arguments", async () => {
      const sync = new ConvexWorkspaceSync({ convexUrl: "https://test.convex.cloud" });

      await sync.syncStatus("ws-123", "archived");

      expect(mockMutation).toHaveBeenCalledTimes(1);
      const [fnName, args] = mockMutation.mock.calls[0] as [string, Record<string, unknown>];
      expect(fnName).toBe("workspaces:updateStatus");
      expect(args.id).toBe("ws-123");
      expect(args.status).toBe("archived");
    });

    it("does not throw when mutation fails", async () => {
      mockMutation.mockImplementation(() => Promise.reject(new Error("network error")));
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      const sync = new ConvexWorkspaceSync({ convexUrl: "https://test.convex.cloud" });
      await sync.syncStatus("ws-123", "archived");

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("syncTunnel", () => {
    it("calls updateTunnel mutation with correct arguments", async () => {
      const sync = new ConvexWorkspaceSync({ convexUrl: "https://test.convex.cloud" });

      await sync.syncTunnel("ws-123", "https://tunnel.example.com", 8081, "session-1");

      expect(mockMutation).toHaveBeenCalledTimes(1);
      const [fnName, args] = mockMutation.mock.calls[0] as [string, Record<string, unknown>];
      expect(fnName).toBe("workspaces:updateTunnel");
      expect(args.id).toBe("ws-123");
      expect(args.tunnelUrl).toBe("https://tunnel.example.com");
      expect(args.metroPort).toBe(8081);
      expect(args.sessionId).toBe("session-1");
    });

    it("omits null tunnelUrl from args", async () => {
      const sync = new ConvexWorkspaceSync({ convexUrl: "https://test.convex.cloud" });

      await sync.syncTunnel("ws-123", null);

      const [, args] = mockMutation.mock.calls[0] as [string, Record<string, unknown>];
      expect(args.tunnelUrl).toBeUndefined();
      expect(args.id).toBe("ws-123");
    });

    it("does not throw when mutation fails", async () => {
      mockMutation.mockImplementation(() => Promise.reject(new Error("network error")));
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      const sync = new ConvexWorkspaceSync({ convexUrl: "https://test.convex.cloud" });
      await sync.syncTunnel("ws-123", "https://tunnel.example.com");

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("removeWorkspace", () => {
    it("calls remove mutation with correct arguments", async () => {
      const sync = new ConvexWorkspaceSync({ convexUrl: "https://test.convex.cloud" });

      await sync.removeWorkspace("ws-123");

      expect(mockMutation).toHaveBeenCalledTimes(1);
      const [fnName, args] = mockMutation.mock.calls[0] as [string, Record<string, unknown>];
      expect(fnName).toBe("workspaces:remove");
      expect(args.id).toBe("ws-123");
    });

    it("does not throw when mutation fails", async () => {
      mockMutation.mockImplementation(() => Promise.reject(new Error("network error")));
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      const sync = new ConvexWorkspaceSync({ convexUrl: "https://test.convex.cloud" });
      await sync.removeWorkspace("ws-123");

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("disabled sync", () => {
    it("skips all calls when disabled", async () => {
      const sync = new ConvexWorkspaceSync({
        convexUrl: "https://test.convex.cloud",
        enabled: false,
      });

      await sync.syncWorkspace(makeConfig());
      await sync.syncStatus("ws-123", "archived");
      await sync.syncTunnel("ws-123", "https://tunnel.example.com");
      await sync.removeWorkspace("ws-123");

      expect(mockMutation).not.toHaveBeenCalled();
    });
  });
});
