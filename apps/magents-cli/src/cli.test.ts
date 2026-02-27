import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ControlClient } from "@magents/sdk";

import type { AgentDeps, SpecialistDeps } from "./cli";
import { runCli } from "./cli";
import { SpecialistRegistry, type InteractiveIO } from "./specialist-registry";
import type { AgentMetadata, Conversation, ConversationMessage, OpenCodeClientInterface } from "./agent-manager";
import { AgentManager } from "./agent-manager";
import type { ServerInfo } from "./opencode-server";
import { LocalControlTransport } from "./control-transport";
import type { MagentsGlobalConfig } from "./global-config";
import type { OpencodeResolverDeps } from "./opencode-resolver";
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

// --- opencode command group tests ---

function createOpencodeExecMock(opts: {
  whichResult?: string;
  version?: string;
  helpOutput?: string;
  whichError?: boolean;
  versionError?: boolean;
  helpError?: boolean;
}) {
  return async (cmd: string) => {
    if (cmd === "which opencode") {
      if (opts.whichError) throw new Error("command not found");
      return { stdout: opts.whichResult ?? "/usr/local/bin/opencode\n", stderr: "" };
    }
    if (cmd.endsWith("--version")) {
      if (opts.versionError) throw new Error("command failed");
      return { stdout: opts.version ?? "1.2.14\n", stderr: "" };
    }
    if (cmd.endsWith("--help")) {
      if (opts.helpError) throw new Error("command failed");
      return { stdout: opts.helpOutput ?? "Usage: opencode [options]\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

function createOpencodeResolverDeps(
  overrides: Partial<OpencodeResolverDeps> = {},
): OpencodeResolverDeps {
  let storedConfig: MagentsGlobalConfig = {};
  return {
    exec: createOpencodeExecMock({}),
    readConfig: async () => storedConfig,
    writeConfig: async (config) => {
      storedConfig = config;
    },
    ...overrides,
  };
}

function setupTestCliWithOpencode(resolverDeps: Partial<OpencodeResolverDeps> = {}) {
  const base = setupTestCli();
  const opencodeResolverDeps = createOpencodeResolverDeps(resolverDeps);
  return {
    ...base,
    deps: { ...base.deps, opencodeResolverDeps },
  };
}

describe("CLI opencode commands", () => {
  it("opencode status succeeds with auto-detected path", async () => {
    const exec = createOpencodeExecMock({ whichResult: "/usr/local/bin/opencode\n", version: "1.2.14\n" });
    const { deps, output, errors } = setupTestCliWithOpencode({ exec });

    const code = await runCli(["opencode", "status"], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    const result = JSON.parse(output[0]);
    expect(result.path).toBe("/usr/local/bin/opencode");
    expect(result.version).toBe("1.2.14");
    expect(result.source).toBe("auto-detected");
  });

  it("opencode status succeeds with config path", async () => {
    const exec = createOpencodeExecMock({ version: "2.0.0\n" });
    const { deps, output, errors } = setupTestCliWithOpencode({
      exec,
      readConfig: async () => ({ opencodePath: "/custom/opencode" }),
    });

    const code = await runCli(["opencode", "status"], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    const result = JSON.parse(output[0]);
    expect(result.path).toBe("/custom/opencode");
    expect(result.version).toBe("2.0.0");
    expect(result.source).toBe("config");
  });

  it("opencode status fails when not found", async () => {
    const exec = createOpencodeExecMock({ whichError: true });
    const { deps, errors } = setupTestCliWithOpencode({ exec });

    const code = await runCli(["opencode", "status"], deps);

    expect(code).toBe(1);
    expect(errors[0]).toContain("OPENCODE_NOT_FOUND");
  });

  it("opencode set-path --path <valid> succeeds", async () => {
    let savedConfig: MagentsGlobalConfig = {};
    const exec = createOpencodeExecMock({ version: "1.5.0\n" });
    const { deps, output, errors } = setupTestCliWithOpencode({
      exec,
      writeConfig: async (config) => {
        savedConfig = config;
      },
    });

    const code = await runCli(["opencode", "set-path", "--path", "/opt/opencode"], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    const result = JSON.parse(output[0]);
    expect(result.path).toBe("/opt/opencode");
    expect(result.version).toBe("1.5.0");
    expect(result.saved).toBe(true);
    expect(savedConfig.opencodePath).toBe("/opt/opencode");
  });

  it("opencode set-path without --path flag errors", async () => {
    const { deps, errors } = setupTestCliWithOpencode();

    const code = await runCli(["opencode", "set-path"], deps);

    expect(code).toBe(1);
    expect(errors[0]).toContain("Missing required flag --path");
  });

  it("opencode detect succeeds", async () => {
    const exec = createOpencodeExecMock({ whichResult: "/usr/bin/opencode\n", version: "1.0.0\n" });
    const { deps, output, errors } = setupTestCliWithOpencode({ exec });

    const code = await runCli(["opencode", "detect"], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    const result = JSON.parse(output[0]);
    expect(result.path).toBe("/usr/bin/opencode");
    expect(result.version).toBe("1.0.0");
  });

  it("opencode detect fails when not installed", async () => {
    const exec = createOpencodeExecMock({ whichError: true });
    const { deps, errors } = setupTestCliWithOpencode({ exec });

    const code = await runCli(["opencode", "detect"], deps);

    expect(code).toBe(1);
    expect(errors[0]).toContain("OPENCODE_NOT_FOUND");
  });

  it("unknown opencode subcommand errors", async () => {
    const { deps, errors } = setupTestCliWithOpencode();

    const code = await runCli(["opencode", "foobar"], deps);

    expect(code).toBe(1);
    expect(errors[0]).toContain("Unknown command: opencode foobar");
  });
});

// --- agent command group tests ---

function createMockServerInfo(): ServerInfo {
  return { pid: 12345, port: 4096, url: "http://127.0.0.1:4096", startedAt: "2026-01-01T00:00:00.000Z" };
}

function createMockOpenCodeClient(): OpenCodeClientInterface {
  const sessions = new Map<string, { id: string; title: string }>();
  let sessionSeq = 0;

  return {
    session: {
      async create(params) {
        sessionSeq += 1;
        const id = `oc-sess-${sessionSeq}`;
        const data = { id, slug: id, title: params?.title ?? "untitled" };
        sessions.set(id, data);
        return { data };
      },
      async prompt(params) {
        return {
          data: {
            info: { id: `msg-1`, role: "assistant" },
            parts: [{ type: "text", text: "Mock response" }],
          },
        };
      },
      async messages(params) {
        return {
          data: [
            {
              info: { id: "msg-0", role: "user", time: { created: Date.now() } },
              parts: [{ type: "text", text: "Hello" }],
            },
            {
              info: { id: "msg-1", role: "assistant", time: { created: Date.now() } },
              parts: [{ type: "text", text: "Hi there" }],
            },
          ],
        };
      },
      async delete(params) {
        sessions.delete(params.path.id);
      },
    },
  };
}

class MockAgentManager extends AgentManager {
  private agents = new Map<string, AgentMetadata>();
  private conversations = new Map<string, Conversation>();
  private seq = 0;

  constructor() {
    super({ client: createMockOpenCodeClient() });
  }

  override async createAgent(
    _workspacePath: string,
    options: {
      label: string;
      model?: string;
      agent?: string;
      specialistId?: string;
      systemPrompt?: string;
    },
  ): Promise<AgentMetadata> {
    this.seq += 1;
    const agentId = `agent-mock${this.seq}`;
    const metadata: AgentMetadata = {
      agentId,
      sessionId: `oc-sess-${this.seq}`,
      label: options.label,
      model: options.model,
      agent: options.agent,
      specialistId: options.specialistId,
      systemPrompt: options.systemPrompt,
      createdAt: new Date().toISOString(),
    };
    this.agents.set(agentId, metadata);
    this.conversations.set(agentId, { agentId, sessionId: metadata.sessionId, messages: [] });
    return metadata;
  }

  override async listAgents(_workspacePath: string): Promise<AgentMetadata[]> {
    return Array.from(this.agents.values());
  }

  override async getAgent(_workspacePath: string, agentId: string): Promise<AgentMetadata> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found.`);
    return agent;
  }

  override async removeAgent(_workspacePath: string, agentId: string): Promise<void> {
    this.agents.delete(agentId);
    this.conversations.delete(agentId);
  }

  override async sendMessage(
    _workspacePath: string,
    agentId: string,
    text: string,
  ): Promise<ConversationMessage> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found.`);
    const msg: ConversationMessage = {
      role: "assistant",
      content: "Mock response",
      parts: [{ type: "text", text: "Mock response" }],
      timestamp: new Date().toISOString(),
    };
    const conv = this.conversations.get(agentId)!;
    conv.messages.push(
      { role: "user", content: text, parts: [{ type: "text", text }], timestamp: new Date().toISOString() },
      msg,
    );
    return msg;
  }

  override async getConversation(_workspacePath: string, agentId: string): Promise<Conversation> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found.`);
    return this.conversations.get(agentId)!;
  }
}

function createMockAgentDeps(overrides?: {
  serverStartError?: boolean;
  serverRunning?: boolean;
}): { agentDeps: AgentDeps; mockManager: MockAgentManager } {
  const mockInfo = createMockServerInfo();
  const running = overrides?.serverRunning ?? true;
  const mockManager = new MockAgentManager();

  return {
    mockManager,
    agentDeps: {
      server: {
        async start(_workspacePath: string) {
          if (overrides?.serverStartError) {
            throw new Error("Failed to start server");
          }
          return mockInfo;
        },
        async stop(_workspacePath: string) {},
        async status(_workspacePath: string) {
          return running ? { running: true, info: mockInfo } : { running: false };
        },
        async getOrStart(_workspacePath: string) {
          return mockInfo;
        },
      },
      createManager(_serverUrl: string) {
        return mockManager;
      },
    },
  };
}

function setupTestCliWithAgent(agentDepsOverrides?: Parameters<typeof createMockAgentDeps>[0]) {
  const base = setupTestCli();
  const { agentDeps, mockManager } = createMockAgentDeps(agentDepsOverrides);
  return {
    ...base,
    mockManager,
    deps: { ...base.deps, agentDeps },
  };
}

describe("CLI agent commands", () => {
  it("agent server-start outputs server info", async () => {
    const { deps, output, errors } = setupTestCliWithAgent();

    const code = await runCli(["agent", "server-start"], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    const result = JSON.parse(output[0]) as ServerInfo;
    expect(result.pid).toBe(12345);
    expect(result.port).toBe(4096);
    expect(result.url).toBe("http://127.0.0.1:4096");
  });

  it("agent server-stop outputs stopped confirmation", async () => {
    const { deps, output, errors } = setupTestCliWithAgent();

    const code = await runCli(["agent", "server-stop"], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    const result = JSON.parse(output[0]) as { stopped: boolean };
    expect(result.stopped).toBe(true);
  });

  it("agent server-status when running", async () => {
    const { deps, output, errors } = setupTestCliWithAgent({ serverRunning: true });

    const code = await runCli(["agent", "server-status"], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    const result = JSON.parse(output[0]) as { running: boolean; info?: ServerInfo };
    expect(result.running).toBe(true);
    expect(result.info?.port).toBe(4096);
  });

  it("agent server-status when stopped", async () => {
    const { deps, output, errors } = setupTestCliWithAgent({ serverRunning: false });

    const code = await runCli(["agent", "server-status"], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    const result = JSON.parse(output[0]) as { running: boolean };
    expect(result.running).toBe(false);
  });

  it("agent create outputs metadata", async () => {
    const { deps, output, errors } = setupTestCliWithAgent();

    const code = await runCli(["agent", "create", "--label", "my-agent", "--model", "anthropic:claude"], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    const result = JSON.parse(output[0]) as AgentMetadata;
    expect(result.agentId).toMatch(/^agent-/);
    expect(result.label).toBe("my-agent");
    expect(result.model).toBe("anthropic:claude");
    expect(result.sessionId).toMatch(/^oc-sess-/);
  });

  it("agent create requires --label", async () => {
    const { deps, errors } = setupTestCliWithAgent();

    const code = await runCli(["agent", "create"], deps);

    expect(code).toBe(1);
    expect(errors[0]).toContain("Missing required flag --label");
  });

  it("agent list outputs agents array", async () => {
    const { deps, output, errors } = setupTestCliWithAgent();

    const code = await runCli(["agent", "list"], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    const result = JSON.parse(output[0]) as { agents: AgentMetadata[] };
    expect(Array.isArray(result.agents)).toBe(true);
  });

  it("agent send requires --agent-id and --message", async () => {
    const { deps, errors } = setupTestCliWithAgent();

    const code = await runCli(["agent", "send"], deps);

    expect(code).toBe(1);
    expect(errors[0]).toContain("Missing required flag --agent-id");
  });

  it("agent send requires --message when --agent-id is given", async () => {
    const { deps, errors } = setupTestCliWithAgent();

    const code = await runCli(["agent", "send", "--agent-id", "agent-abc"], deps);

    expect(code).toBe(1);
    expect(errors[0]).toContain("Missing required flag --message");
  });

  it("agent conversation requires --agent-id", async () => {
    const { deps, errors } = setupTestCliWithAgent();

    const code = await runCli(["agent", "conversation"], deps);

    expect(code).toBe(1);
    expect(errors[0]).toContain("Missing required flag --agent-id");
  });

  it("agent remove requires --agent-id", async () => {
    const { deps, errors } = setupTestCliWithAgent();

    const code = await runCli(["agent", "remove"], deps);

    expect(code).toBe(1);
    expect(errors[0]).toContain("Missing required flag --agent-id");
  });

  it("agent server-start propagates server error", async () => {
    const { deps, errors } = setupTestCliWithAgent({ serverStartError: true });

    const code = await runCli(["agent", "server-start"], deps);

    expect(code).toBe(1);
    expect(errors[0]).toContain("Failed to start server");
  });

  it("unknown agent subcommand errors", async () => {
    const { deps, errors } = setupTestCliWithAgent();

    const code = await runCli(["agent", "foobar"], deps);

    expect(code).toBe(1);
    expect(errors[0]).toContain("Unknown command: agent foobar");
  });

  it("agent commands respect --workspace-path flag", async () => {
    const { deps, output, errors } = setupTestCliWithAgent();

    const code = await runCli(
      ["agent", "server-status", "--workspace-path", "/custom/path"],
      deps,
    );

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
  });
});

// --- specialist command group tests + agent create --specialist tests ---

function makeSpecialistMd(opts: {
  name: string;
  description: string;
  modelTier?: string;
  roleReminder?: string;
  defaultModel?: string;
  body: string;
}): string {
  const lines = ["---"];
  lines.push(`name: "${opts.name}"`);
  lines.push(`description: "${opts.description}"`);
  if (opts.modelTier) lines.push(`modelTier: "${opts.modelTier}"`);
  if (opts.roleReminder) lines.push(`roleReminder: "${opts.roleReminder}"`);
  if (opts.defaultModel) lines.push(`defaultModel: "${opts.defaultModel}"`);
  lines.push("---");
  lines.push("");
  lines.push(opts.body);
  return lines.join("\n");
}

async function writeSpecialist(dir: string, id: string, content: string) {
  await Bun.write(path.join(dir, `${id}.md`), content);
}

function createMockIO(responses: {
  prompts?: string[];
  editorContent?: string;
  confirms?: boolean[];
}): InteractiveIO {
  let promptIdx = 0;
  let confirmIdx = 0;
  return {
    async prompt(_question: string) {
      return responses.prompts?.[promptIdx++] ?? "";
    },
    async openEditor(_initialContent?: string) {
      return responses.editorContent ?? "";
    },
    async confirm(_question: string) {
      return responses.confirms?.[confirmIdx++] ?? false;
    },
  };
}

describe("CLI specialist commands", () => {
  let builtinDir: string;
  let userDir: string;

  beforeEach(async () => {
    builtinDir = await mkdtemp(path.join(os.tmpdir(), "magents-cli-builtin-"));
    userDir = await mkdtemp(path.join(os.tmpdir(), "magents-cli-user-"));
  });

  afterEach(async () => {
    await rm(builtinDir, { recursive: true, force: true });
    await rm(userDir, { recursive: true, force: true });
  });

  function setupTestCliWithSpecialist(opts?: {
    io?: InteractiveIO;
    agentDepsOverrides?: Parameters<typeof createMockAgentDeps>[0];
  }) {
    const base = setupTestCli();
    const { agentDeps, mockManager } = createMockAgentDeps(opts?.agentDepsOverrides);
    const registry = new SpecialistRegistry({ builtinDir, userDir });
    const specialistDeps: SpecialistDeps = {
      registry,
      io: opts?.io,
    };
    return {
      ...base,
      mockManager,
      registry,
      deps: { ...base.deps, agentDeps, specialistDeps },
    };
  }

  it("agent create --specialist coordinator resolves from registry", async () => {
    await writeSpecialist(
      builtinDir,
      "coordinator",
      makeSpecialistMd({
        name: "Coordinator",
        description: "Plans and delegates",
        defaultModel: "claude-sonnet-4-5-20250929",
        body: "You are a coordinator.",
      }),
    );

    const { deps, output, errors } = setupTestCliWithSpecialist();

    const code = await runCli(["agent", "create", "--specialist", "coordinator"], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    const result = JSON.parse(output[0]) as AgentMetadata;
    expect(result.label).toBe("Coordinator");
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
    expect(result.specialistId).toBe("coordinator");
    expect(result.systemPrompt).toBe("You are a coordinator.");
  });

  it("agent create --specialist coordinator --label custom uses custom label", async () => {
    await writeSpecialist(
      builtinDir,
      "coordinator",
      makeSpecialistMd({
        name: "Coordinator",
        description: "Plans and delegates",
        body: "You are a coordinator.",
      }),
    );

    const { deps, output, errors } = setupTestCliWithSpecialist();

    const code = await runCli(
      ["agent", "create", "--specialist", "coordinator", "--label", "MyCoord"],
      deps,
    );

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    const result = JSON.parse(output[0]) as AgentMetadata;
    expect(result.label).toBe("MyCoord");
  });

  it("agent create --specialist unknown errors with available specialists", async () => {
    await writeSpecialist(
      builtinDir,
      "coordinator",
      makeSpecialistMd({
        name: "Coordinator",
        description: "Plans and delegates",
        body: "You are a coordinator.",
      }),
    );

    const { deps, errors } = setupTestCliWithSpecialist();

    const code = await runCli(["agent", "create", "--specialist", "unknown"], deps);

    expect(code).toBe(1);
    expect(errors[0]).toContain("SPECIALIST_NOT_FOUND");
    expect(errors[0]).toContain("coordinator");
  });

  it("specialist list shows specialists", async () => {
    await writeSpecialist(
      builtinDir,
      "coordinator",
      makeSpecialistMd({
        name: "Coordinator",
        description: "Plans and delegates",
        body: "You are a coordinator.",
      }),
    );
    await writeSpecialist(
      userDir,
      "my-reviewer",
      makeSpecialistMd({
        name: "My Reviewer",
        description: "Reviews code with security focus",
        body: "Review carefully.",
      }),
    );

    const { deps, output, errors } = setupTestCliWithSpecialist();

    const code = await runCli(["specialist", "list"], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    expect(output[0]).toContain("ID");
    expect(output[0]).toContain("NAME");
    expect(output[0]).toContain("SOURCE");
    expect(output[0]).toContain("coordinator");
    expect(output[0]).toContain("builtin");
    expect(output[0]).toContain("my-reviewer");
    expect(output[0]).toContain("user");
  });

  it("specialist add creates user specialist via editor", async () => {
    const editorContent = makeSpecialistMd({
      name: "My Agent",
      description: "A custom specialist",
      body: "You are my custom agent.",
    });

    const io = createMockIO({
      prompts: ["my-agent"],
      editorContent,
      confirms: [true],
    });

    const { deps, output, errors, registry } = setupTestCliWithSpecialist({ io });

    const code = await runCli(["specialist", "add"], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    const result = JSON.parse(output[0]);
    expect(result.added).toBe(true);
    expect(result.id).toBe("my-agent");

    // Verify it was actually saved
    const saved = await registry.get("my-agent");
    expect(saved).not.toBeNull();
    expect(saved!.name).toBe("My Agent");
    expect(saved!.description).toBe("A custom specialist");
    expect(saved!.systemPrompt).toBe("You are my custom agent.");
  });

  it("specialist add aborts if user declines confirmation", async () => {
    const editorContent = makeSpecialistMd({
      name: "Test",
      description: "Test specialist",
      body: "Prompt content.",
    });

    const io = createMockIO({
      prompts: ["my-agent"],
      editorContent,
      confirms: [false],
    });

    const { deps, output } = setupTestCliWithSpecialist({ io });

    const code = await runCli(["specialist", "add"], deps);

    expect(code).toBe(0);
    expect(output[0]).toBe("Aborted.");
  });

  it("specialist add errors without interactive IO", async () => {
    const { deps, errors } = setupTestCliWithSpecialist();

    const code = await runCli(["specialist", "add"], deps);

    expect(code).toBe(1);
    expect(errors[0]).toContain("NO_INTERACTIVE_IO");
  });

  it("specialist remove --name my-agent removes user specialist", async () => {
    await writeSpecialist(
      userDir,
      "my-agent",
      makeSpecialistMd({
        name: "My Agent",
        description: "Custom specialist",
        body: "Custom prompt.",
      }),
    );

    const { deps, output, errors, registry } = setupTestCliWithSpecialist();

    const code = await runCli(["specialist", "remove", "--name", "my-agent"], deps);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    const result = JSON.parse(output[0]);
    expect(result.removed).toBe(true);
    expect(result.name).toBe("my-agent");

    // Verify it was actually removed
    const removed = await registry.get("my-agent");
    expect(removed).toBeNull();
  });

  it("specialist remove refuses for built-in specialists", async () => {
    await writeSpecialist(
      builtinDir,
      "coordinator",
      makeSpecialistMd({
        name: "Coordinator",
        description: "Built-in",
        body: "Coordinator prompt.",
      }),
    );

    const { deps, errors } = setupTestCliWithSpecialist();

    const code = await runCli(["specialist", "remove", "--name", "coordinator"], deps);

    expect(code).toBe(1);
    expect(errors[0]).toContain("BUILTIN_SPECIALIST");
  });

  it("specialist remove requires --name", async () => {
    const { deps, errors } = setupTestCliWithSpecialist();

    const code = await runCli(["specialist", "remove"], deps);

    expect(code).toBe(1);
    expect(errors[0]).toContain("Missing required flag --name");
  });
});
