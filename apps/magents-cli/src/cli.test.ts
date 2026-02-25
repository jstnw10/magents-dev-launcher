import { describe, expect, it } from "bun:test";
import { ControlClient } from "@magents/sdk";

import { runCli } from "./cli";
import { LocalControlTransport } from "./control-transport";
import { SessionOrchestrator } from "./orchestrator";
import { MockPortAllocator } from "./port-allocator";
import type {
  SessionRecord,
  SessionRegistry,
  TunnelConfig,
  TunnelInfo,
  TunnelManager,
  WorktreeInfo,
  WorktreeManager,
} from "./types";
import { WorkspaceManager } from "./workspace-manager";

class InMemoryRegistry implements SessionRegistry {
  constructor(private readonly sessions: SessionRecord[] = []) {}

  async load() {
    return this.sessions.map((session) => ({
      ...session,
      tunnel: { ...session.tunnel },
      worktree: session.worktree ? { ...session.worktree } : undefined,
    }));
  }

  async save(sessions: SessionRecord[]) {
    this.sessions.length = 0;
    this.sessions.push(
      ...sessions.map((session) => ({
        ...session,
        tunnel: { ...session.tunnel },
        worktree: session.worktree ? { ...session.worktree } : undefined,
      }))
    );
  }
}

class TestWorktreeManager implements WorktreeManager {
  readonly cleanedPaths: string[] = [];

  async provision(input: { sessionId: string; sourceRoot: string; requestedPath?: string }) {
    return input.requestedPath ?? `${input.sourceRoot}/.magents/${input.sessionId}`;
  }

  async cleanup(input: { sourceRoot: string; path: string }) {
    this.cleanedPaths.push(`${input.sourceRoot}:${input.path}`);
  }

  async list(_sourceRoot: string): Promise<WorktreeInfo[]> {
    return [];
  }

  async exists(_worktreePath: string): Promise<boolean> {
    return false;
  }
}

class TestTunnelManager implements TunnelManager {
  private readonly activeTunnels = new Map<
    string,
    { publicUrl: string; metroPort: number; config: TunnelConfig }
  >();

  async attach(input: {
    sessionId: string;
    metroPort: number;
    publicUrl?: string;
    tunnelConfig?: TunnelConfig;
  }) {
    const config: TunnelConfig = input.tunnelConfig ?? { mode: "quick" };
    const publicUrl =
      input.publicUrl ??
      (config.mode === "named"
        ? `https://${config.domain}`
        : `https://${input.sessionId}-${input.metroPort}.test`);

    this.activeTunnels.set(input.sessionId, {
      publicUrl,
      metroPort: input.metroPort,
      config,
    });

    return {
      connected: true as const,
      provider: "cloudflare" as const,
      publicUrl,
    };
  }

  async detach(input: { sessionId: string }) {
    this.activeTunnels.delete(input.sessionId);
    return {
      connected: false as const,
      provider: "none" as const,
    };
  }

  list(): TunnelInfo[] {
    return Array.from(this.activeTunnels.entries()).map(([sessionId, entry]) => ({
      sessionId,
      publicUrl: entry.publicUrl,
      metroPort: entry.metroPort,
      config: entry.config,
    }));
  }

  getStatus(sessionId: string): TunnelInfo | undefined {
    const entry = this.activeTunnels.get(sessionId);
    if (!entry) return undefined;
    return {
      sessionId,
      publicUrl: entry.publicUrl,
      metroPort: entry.metroPort,
      config: entry.config,
    };
  }
}

function setupTestCli() {
  const registry = new InMemoryRegistry();
  const worktrees = new TestWorktreeManager();
  let sequence = 0;
  const orchestrator = new SessionOrchestrator({
    registry,
    worktrees,
    tunnels: new TestTunnelManager(),
    ports: new MockPortAllocator(),
    idFactory: () => {
      sequence += 1;
      return `sess-${sequence}`;
    },
  });
  const controlClient = new ControlClient(new LocalControlTransport(orchestrator), {
    correlationIdFactory: () => "corr-test",
  });
  const workspaceManager = new WorkspaceManager({ worktrees });
  const output: string[] = [];
  const errors: string[] = [];

  const deps = {
    controlClient,
    orchestrator,
    workspaceManager,
    syncEnabled: false,
    cwd: "/repo/project",
    stdout: (line: string) => {
      output.push(line);
    },
    stderr: (line: string) => {
      errors.push(line);
    },
  };

  return { deps, output, errors, orchestrator };
}

describe("CLI orchestration", () => {
  it("creates multiple sessions with unique ids and metro ports", async () => {
    const { deps, output, errors } = setupTestCli();

    const first = await runCli(["session", "start", "--label", "Device A"], deps);
    const second = await runCli(["session", "start", "--label", "Device B"], deps);
    const listed = await runCli(["session", "list"], deps);

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(listed).toBe(0);
    expect(errors).toHaveLength(0);

    const listPayload = JSON.parse(output[2]) as { sessions: Array<{ id: string; metroUrl: string }> };
    expect(listPayload.sessions).toHaveLength(2);
    expect(new Set(listPayload.sessions.map((session) => session.id)).size).toBe(2);
    expect(listPayload.sessions.map((session) => session.metroUrl)).toEqual([
      "http://127.0.0.1:8081",
      "http://127.0.0.1:8082",
    ]);
  });

  it("session start with --tunnel creates a quick tunnel", async () => {
    const { deps, output, errors } = setupTestCli();

    const code = await runCli(["session", "start", "--label", "Tunneled", "--tunnel"], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const result = JSON.parse(output[0]) as { session: { tunnelUrl?: string } };
    expect(result.session.tunnelUrl).toContain(".test");
  });

  it("session start with --tunnel --tunnel-name --domain creates a named tunnel", async () => {
    const { deps, output, errors } = setupTestCli();

    const code = await runCli(
      [
        "session", "start",
        "--label", "Named",
        "--tunnel",
        "--tunnel-name", "my-tunnel",
        "--domain", "app.example.com",
      ],
      deps,
    );

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const result = JSON.parse(output[0]) as { session: { tunnelUrl?: string } };
    expect(result.session.tunnelUrl).toBe("https://app.example.com");
  });

  it("tunnel list returns active tunnels", async () => {
    const { deps, output, errors } = setupTestCli();

    await runCli(["session", "start", "--label", "A", "--tunnel"], deps);
    await runCli(["session", "start", "--label", "B", "--tunnel"], deps);
    const code = await runCli(["tunnel", "list"], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const result = JSON.parse(output[2]) as {
      tunnels: Array<{ sessionId: string; publicUrl: string; config: { mode: string } }>;
    };
    expect(result.tunnels).toHaveLength(2);
    expect(result.tunnels[0].config.mode).toBe("quick");
  });

  it("tunnel status returns info for a session with an active tunnel", async () => {
    const { deps, output, errors } = setupTestCli();

    await runCli(["session", "start", "--label", "A", "--tunnel"], deps);
    const started = JSON.parse(output[0]) as { session: { id: string } };
    const code = await runCli(["tunnel", "status", "--session-id", started.session.id], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const result = JSON.parse(output[1]) as {
      tunnel: { sessionId: string; publicUrl: string; config: { mode: string } };
    };
    expect(result.tunnel.sessionId).toBe(started.session.id);
    expect(result.tunnel.config.mode).toBe("quick");
  });

  it("tunnel status returns error for session without tunnel", async () => {
    const { deps, output, errors } = setupTestCli();

    await runCli(["session", "start", "--label", "A"], deps);
    const started = JSON.parse(output[0]) as { session: { id: string } };
    const code = await runCli(["tunnel", "status", "--session-id", started.session.id], deps);

    expect(code).toBe(1);
    expect(errors[0]).toContain("TUNNEL_NOT_FOUND");
  });

  it("tunnel attach with --tunnel-name --domain uses named mode", async () => {
    const { deps, output, errors } = setupTestCli();

    await runCli(["session", "start", "--label", "A"], deps);
    const started = JSON.parse(output[0]) as { session: { id: string } };

    const code = await runCli(
      [
        "tunnel", "attach",
        "--session-id", started.session.id,
        "--tunnel-name", "prod-tunnel",
        "--domain", "prod.example.com",
      ],
      deps,
    );

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const result = JSON.parse(output[1]) as {
      sessionId: string;
      tunnel: { connected: boolean; publicUrl: string };
    };
    expect(result.tunnel.connected).toBe(true);
    expect(result.tunnel.publicUrl).toBe("https://prod.example.com");
  });

  it("rejects --tunnel-name without --domain", async () => {
    const { deps, errors } = setupTestCli();

    const code = await runCli(
      ["session", "start", "--label", "Bad", "--tunnel", "--tunnel-name", "my-tunnel"],
      deps,
    );

    expect(code).toBe(1);
    expect(errors[0]).toContain("Both --tunnel-name and --domain must be provided");
  });

  it("session stop cleans up tunnel", async () => {
    const { deps, output, errors } = setupTestCli();

    await runCli(["session", "start", "--label", "A", "--tunnel"], deps);
    const started = JSON.parse(output[0]) as { session: { id: string } };

    // Verify tunnel is active
    await runCli(["tunnel", "list"], deps);
    const beforeStop = JSON.parse(output[1]) as { tunnels: unknown[] };
    expect(beforeStop.tunnels).toHaveLength(1);

    // Stop session
    await runCli(["session", "stop", "--session-id", started.session.id], deps);

    // Verify tunnel is cleaned up
    await runCli(["tunnel", "list"], deps);
    const afterStop = JSON.parse(output[3]) as { tunnels: unknown[] };
    expect(afterStop.tunnels).toHaveLength(0);
  });

  it("single session with quick tunnel: full lifecycle", async () => {
    const { deps, output, errors } = setupTestCli();

    // Create session with tunnel
    const startCode = await runCli(["session", "start", "--label", "Quick", "--tunnel"], deps);
    expect(startCode).toBe(0);

    const started = JSON.parse(output[0]) as { session: { id: string; tunnelUrl: string } };
    expect(started.session.tunnelUrl).toContain(".test");

    // Verify tunnel active via status
    const statusCode = await runCli(
      ["tunnel", "status", "--session-id", started.session.id],
      deps,
    );
    expect(statusCode).toBe(0);
    const status = JSON.parse(output[1]) as {
      tunnel: { sessionId: string; publicUrl: string; config: { mode: string } };
    };
    expect(status.tunnel.publicUrl).toBe(started.session.tunnelUrl);

    // Detach tunnel
    const detachCode = await runCli(["tunnel", "detach", "--session-id", started.session.id], deps);
    expect(detachCode).toBe(0);

    // Verify tunnel is gone
    const statusAfter = await runCli(
      ["tunnel", "status", "--session-id", started.session.id],
      deps,
    );
    expect(statusAfter).toBe(1);
    expect(errors[0]).toContain("TUNNEL_NOT_FOUND");

    // Stop session
    const stopCode = await runCli(["session", "stop", "--session-id", started.session.id], deps);
    expect(stopCode).toBe(0);
  });

  it("multiple sessions get unique sequential ports", async () => {
    const { deps, output } = setupTestCli();

    await runCli(["session", "start", "--label", "S1"], deps);
    await runCli(["session", "start", "--label", "S2"], deps);
    await runCli(["session", "start", "--label", "S3"], deps);

    const s1 = JSON.parse(output[0]) as { session: { metroUrl: string } };
    const s2 = JSON.parse(output[1]) as { session: { metroUrl: string } };
    const s3 = JSON.parse(output[2]) as { session: { metroUrl: string } };

    // MockPortAllocator starts at 8081 and increments
    expect(s1.session.metroUrl).toBe("http://127.0.0.1:8081");
    expect(s2.session.metroUrl).toBe("http://127.0.0.1:8082");
    expect(s3.session.metroUrl).toBe("http://127.0.0.1:8083");

    // All unique
    const urls = [s1.session.metroUrl, s2.session.metroUrl, s3.session.metroUrl];
    expect(new Set(urls).size).toBe(3);
  });

  it("multiple simultaneous tunnels with different URLs", async () => {
    const { deps, output, errors } = setupTestCli();

    await runCli(["session", "start", "--label", "T1", "--tunnel"], deps);
    await runCli(["session", "start", "--label", "T2", "--tunnel"], deps);

    const s1 = JSON.parse(output[0]) as { session: { id: string; tunnelUrl: string } };
    const s2 = JSON.parse(output[1]) as { session: { id: string; tunnelUrl: string } };

    // Different URLs
    expect(s1.session.tunnelUrl).not.toBe(s2.session.tunnelUrl);

    // List shows both
    const listCode = await runCli(["tunnel", "list"], deps);
    expect(listCode).toBe(0);
    const listed = JSON.parse(output[2]) as {
      tunnels: Array<{ sessionId: string; publicUrl: string }>;
    };
    expect(listed.tunnels).toHaveLength(2);
    expect(listed.tunnels.map((t) => t.sessionId).sort()).toEqual(
      [s1.session.id, s2.session.id].sort(),
    );

    // Stop both
    await runCli(["session", "stop", "--session-id", s1.session.id], deps);
    await runCli(["session", "stop", "--session-id", s2.session.id], deps);

    const listAfter = await runCli(["tunnel", "list"], deps);
    expect(listAfter).toBe(0);
    const afterStop = JSON.parse(output[5]) as { tunnels: unknown[] };
    expect(afterStop.tunnels).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("tunnel status returns full JSON with port, URL, provider-equivalent, mode", async () => {
    const { deps, output } = setupTestCli();

    await runCli(["session", "start", "--label", "StatusCheck", "--tunnel"], deps);
    const started = JSON.parse(output[0]) as { session: { id: string } };

    const code = await runCli(["tunnel", "status", "--session-id", started.session.id], deps);
    expect(code).toBe(0);

    const result = JSON.parse(output[1]) as {
      tunnel: {
        sessionId: string;
        publicUrl: string;
        metroPort: number;
        config: { mode: string };
      };
    };

    expect(result.tunnel.sessionId).toBe(started.session.id);
    expect(result.tunnel.metroPort).toBe(8081);
    expect(result.tunnel.publicUrl).toContain("https://");
    expect(result.tunnel.config.mode).toBe("quick");
  });

  it("error: tunnel attach to non-existent session", async () => {
    const { deps, errors } = setupTestCli();

    const code = await runCli(
      ["tunnel", "attach", "--session-id", "nonexistent-session"],
      deps,
    );

    expect(code).toBe(1);
    expect(errors[0]).toContain("SESSION_NOT_FOUND");
  });

  it("error: tunnel detach from non-existent session", async () => {
    const { deps, errors } = setupTestCli();

    const code = await runCli(
      ["tunnel", "detach", "--session-id", "nonexistent-session"],
      deps,
    );

    expect(code).toBe(1);
    expect(errors[0]).toContain("SESSION_NOT_FOUND");
  });

  it("session stop cleans up tunnel automatically", async () => {
    const { deps, output } = setupTestCli();

    await runCli(["session", "start", "--label", "AutoClean", "--tunnel"], deps);
    const started = JSON.parse(output[0]) as { session: { id: string; tunnelUrl: string } };
    expect(started.session.tunnelUrl).toBeDefined();

    // Confirm tunnel is active
    await runCli(["tunnel", "list"], deps);
    const before = JSON.parse(output[1]) as { tunnels: unknown[] };
    expect(before.tunnels).toHaveLength(1);

    // Stop session — should auto-cleanup tunnel
    await runCli(["session", "stop", "--session-id", started.session.id], deps);

    // Verify tunnel is gone
    await runCli(["tunnel", "list"], deps);
    const after = JSON.parse(output[3]) as { tunnels: unknown[] };
    expect(after.tunnels).toHaveLength(0);

    // Status should also report not found
    const statusCode = await runCli(
      ["tunnel", "status", "--session-id", started.session.id],
      deps,
    );
    expect(statusCode).toBe(1);
  });

  it("port allocation resilience: custom start port", async () => {
    // Use a MockPortAllocator starting at 9000 to simulate 8081 being unavailable
    const registry = new InMemoryRegistry();
    const worktrees = new TestWorktreeManager();
    let sequence = 0;
    const orchestrator = new SessionOrchestrator({
      registry,
      worktrees,
      tunnels: new TestTunnelManager(),
      ports: new MockPortAllocator(9000),
      idFactory: () => {
        sequence += 1;
        return `sess-${sequence}`;
      },
    });
    const controlClient = new ControlClient(new LocalControlTransport(orchestrator), {
      correlationIdFactory: () => "corr-test",
    });
    const workspaceManager = new WorkspaceManager({ worktrees });
    const output: string[] = [];
    const errors: string[] = [];
    const deps = {
      controlClient,
      orchestrator,
      workspaceManager,
      syncEnabled: false,
      cwd: "/repo/project",
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };

    const code = await runCli(["session", "start", "--label", "Resilient"], deps);
    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const result = JSON.parse(output[0]) as { session: { metroUrl: string } };
    expect(result.session.metroUrl).toBe("http://127.0.0.1:9000");
  });

  it("named tunnel with custom domain via session start", async () => {
    const { deps, output, errors } = setupTestCli();

    const code = await runCli(
      [
        "session", "start",
        "--label", "NamedFull",
        "--tunnel",
        "--tunnel-name", "prod-tunnel",
        "--domain", "myapp.example.com",
      ],
      deps,
    );

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const started = JSON.parse(output[0]) as { session: { id: string; tunnelUrl: string } };
    expect(started.session.tunnelUrl).toBe("https://myapp.example.com");

    // Tunnel list should show mode as named
    const listCode = await runCli(["tunnel", "list"], deps);
    expect(listCode).toBe(0);

    const listed = JSON.parse(output[1]) as {
      tunnels: Array<{ sessionId: string; publicUrl: string; config: { mode: string; tunnelName?: string; domain?: string } }>;
    };
    expect(listed.tunnels).toHaveLength(1);
    expect(listed.tunnels[0].config.mode).toBe("named");
    expect(listed.tunnels[0].publicUrl).toBe("https://myapp.example.com");
  });

  it("handles worktree and tunnel lifecycle commands", async () => {
    const { deps, output, errors, orchestrator } = setupTestCli();

    await runCli(["session", "start", "--label", "Device A", "--project-root", "/repo/source"], deps);
    const started = JSON.parse(output[0]) as { session: { id: string } };

    const provisioned = await runCli(
      [
        "worktree",
        "provision",
        "--session-id",
        started.session.id,
        "--source-root",
        "/repo/source",
        "--path",
        "/repo/source/.worktrees/sess-1",
      ],
      deps
    );
    const attached = await runCli(["tunnel", "attach", "--session-id", started.session.id], deps);
    const endpointWithTunnel = await runCli(["session", "endpoint", "--session-id", started.session.id], deps);
    const detached = await runCli(["tunnel", "detach", "--session-id", started.session.id], deps);
    const endpointWithoutTunnel = await runCli(["session", "endpoint", "--session-id", started.session.id], deps);
    const cleaned = await runCli(["worktree", "cleanup", "--session-id", started.session.id], deps);

    expect(provisioned).toBe(0);
    expect(attached).toBe(0);
    expect(endpointWithTunnel).toBe(0);
    expect(detached).toBe(0);
    expect(endpointWithoutTunnel).toBe(0);
    expect(cleaned).toBe(0);
    expect(errors).toHaveLength(0);

    const afterCleanup = await orchestrator.getSession(started.session.id);
    const endpointConnected = JSON.parse(output[3]) as { tunnel: { connected: boolean; publicUrl?: string } };
    const endpointDisconnected = JSON.parse(output[5]) as { tunnel: { connected: boolean; publicUrl?: string } };

    expect(endpointConnected.tunnel.connected).toBe(true);
    expect(endpointConnected.tunnel.publicUrl).toContain(started.session.id);
    expect(endpointDisconnected.tunnel.connected).toBe(false);
    expect(afterCleanup?.projectRoot).toBe("/repo/source");
    expect(afterCleanup?.worktree).toBeUndefined();
  });
});
