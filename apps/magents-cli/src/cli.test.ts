import { describe, expect, it } from "bun:test";
import { ControlClient } from "@magents/sdk";

import { runCli } from "./cli";
import { LocalControlTransport } from "./control-transport";
import { SessionOrchestrator } from "./orchestrator";
import type { SessionRecord, SessionRegistry, TunnelManager, WorktreeManager } from "./types";

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
}

class TestTunnelManager implements TunnelManager {
  async attach(input: { sessionId: string; metroPort: number; publicUrl?: string }) {
    return {
      connected: true as const,
      provider: "cloudflare" as const,
      publicUrl: input.publicUrl ?? `https://${input.sessionId}-${input.metroPort}.test`,
    };
  }

  async detach(_input: { sessionId: string }) {
    return {
      connected: false as const,
      provider: "none" as const,
    };
  }
}

function setupTestCli() {
  const registry = new InMemoryRegistry();
  let sequence = 0;
  const orchestrator = new SessionOrchestrator({
    registry,
    worktrees: new TestWorktreeManager(),
    tunnels: new TestTunnelManager(),
    idFactory: () => {
      sequence += 1;
      return `sess-${sequence}`;
    },
  });
  const controlClient = new ControlClient(new LocalControlTransport(orchestrator), {
    correlationIdFactory: () => "corr-test",
  });
  const output: string[] = [];
  const errors: string[] = [];

  const deps = {
    controlClient,
    orchestrator,
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
