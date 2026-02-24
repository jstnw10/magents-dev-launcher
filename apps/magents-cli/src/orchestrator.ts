import type { CommandMap, SessionId, TunnelState } from "@magents/protocol";

import {
  createSessionSummary,
  DEFAULT_METRO_PORT,
  OrchestrationError,
  type SessionOrchestratorOptions,
  type SessionRecord,
  type TunnelConfig,
  type TunnelInfo,
} from "./types";

function defaultSessionIdFactory() {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SessionOrchestrator {
  private readonly createSessionId: () => SessionId;

  constructor(private readonly options: SessionOrchestratorOptions) {
    this.createSessionId = options.idFactory ?? defaultSessionIdFactory;
  }

  async createSession(
    input: CommandMap["session.create"]["request"] & { tunnelConfig?: TunnelConfig },
  ) {
    const metroPort = input.metroPort ?? (await this.allocatePort());

    const sessions = await this.options.registry.load();
    const activePortTaken = sessions.some(
      (session) => session.metroPort === metroPort && session.state !== "stopped"
    );

    if (activePortTaken) {
      throw new OrchestrationError("PORT_IN_USE", `Metro port ${metroPort} is already assigned.`);
    }

    const session: SessionRecord = {
      id: this.createSessionId(),
      label: input.label,
      projectRoot: input.projectRoot,
      metroPort,
      state: "running",
      tunnel: {
        connected: false,
        provider: "none",
      },
    };

    if (input.tunnelEnabled) {
      session.tunnel = await this.options.tunnels.attach({
        sessionId: session.id,
        metroPort: session.metroPort,
        tunnelConfig: input.tunnelConfig,
      });
    }

    sessions.push(session);
    await this.options.registry.save(sessions);

    return {
      session: createSessionSummary(session),
    };
  }

  async listSessions() {
    const sessions = await this.options.registry.load();
    return {
      sessions: sessions.map((session) => createSessionSummary(session)),
    };
  }

  async stopSession(input: CommandMap["session.stop"]["request"]) {
    const sessions = await this.options.registry.load();
    const session = sessions.find((candidate) => candidate.id === input.sessionId);

    if (!session) {
      throw new OrchestrationError("SESSION_NOT_FOUND", `Session ${input.sessionId} was not found.`);
    }

    if (session.tunnel.connected) {
      session.tunnel = await this.options.tunnels.detach({
        sessionId: session.id,
      });
    }

    session.state = "stopped";
    this.options.ports?.release(session.metroPort);
    await this.options.registry.save(sessions);

    return {
      sessionId: session.id,
      stopped: true,
    };
  }

  async resolveEndpoint(input: CommandMap["session.resolveEndpoint"]["request"]) {
    const session = await this.getSession(input.sessionId);

    if (!session) {
      throw new OrchestrationError("SESSION_NOT_FOUND", `Session ${input.sessionId} was not found.`);
    }

    return {
      sessionId: session.id,
      metroUrl: `http://127.0.0.1:${session.metroPort}`,
      tunnel: session.tunnel,
    };
  }

  async provisionWorktree(input: { sessionId: SessionId; sourceRoot?: string; path?: string }) {
    const sessions = await this.options.registry.load();
    const session = sessions.find((candidate) => candidate.id === input.sessionId);

    if (!session) {
      throw new OrchestrationError("SESSION_NOT_FOUND", `Session ${input.sessionId} was not found.`);
    }

    const sourceRoot = input.sourceRoot ?? session.worktree?.sourceRoot ?? session.projectRoot;
    const worktreePath = await this.options.worktrees.provision({
      sessionId: session.id,
      sourceRoot,
      requestedPath: input.path,
    });

    session.worktree = {
      sourceRoot,
      path: worktreePath,
    };
    session.projectRoot = worktreePath;
    await this.options.registry.save(sessions);

    return {
      sessionId: session.id,
      path: worktreePath,
    };
  }

  async cleanupWorktree(input: { sessionId: SessionId }) {
    const sessions = await this.options.registry.load();
    const session = sessions.find((candidate) => candidate.id === input.sessionId);

    if (!session) {
      throw new OrchestrationError("SESSION_NOT_FOUND", `Session ${input.sessionId} was not found.`);
    }

    if (!session.worktree) {
      throw new OrchestrationError(
        "WORKTREE_NOT_FOUND",
        `Session ${input.sessionId} does not have a managed worktree.`
      );
    }

    await this.options.worktrees.cleanup({
      sourceRoot: session.worktree.sourceRoot,
      path: session.worktree.path,
    });

    session.projectRoot = session.worktree.sourceRoot;
    session.worktree = undefined;
    await this.options.registry.save(sessions);

    return {
      sessionId: session.id,
      cleaned: true,
    };
  }

  async attachTunnel(input: {
    sessionId: SessionId;
    publicUrl?: string;
    tunnelConfig?: TunnelConfig;
  }) {
    const sessions = await this.options.registry.load();
    const session = sessions.find((candidate) => candidate.id === input.sessionId);

    if (!session) {
      throw new OrchestrationError("SESSION_NOT_FOUND", `Session ${input.sessionId} was not found.`);
    }

    session.tunnel = await this.options.tunnels.attach({
      sessionId: session.id,
      metroPort: session.metroPort,
      publicUrl: input.publicUrl,
      tunnelConfig: input.tunnelConfig,
    });
    await this.options.registry.save(sessions);

    return {
      sessionId: session.id,
      tunnel: session.tunnel,
    };
  }

  async detachTunnel(input: { sessionId: SessionId }) {
    const sessions = await this.options.registry.load();
    const session = sessions.find((candidate) => candidate.id === input.sessionId);

    if (!session) {
      throw new OrchestrationError("SESSION_NOT_FOUND", `Session ${input.sessionId} was not found.`);
    }

    session.tunnel = await this.options.tunnels.detach({
      sessionId: session.id,
    });
    await this.options.registry.save(sessions);

    return {
      sessionId: session.id,
      tunnel: session.tunnel,
    };
  }

  listTunnels(): TunnelInfo[] {
    return this.options.tunnels.list();
  }

  getTunnelStatus(sessionId: SessionId): TunnelInfo | undefined {
    return this.options.tunnels.getStatus(sessionId);
  }

  async allocatePort(): Promise<number> {
    if (this.options.ports) {
      return this.options.ports.allocate();
    }
    return this.pickNextMetroPort();
  }

  async getSession(sessionId: SessionId) {
    const sessions = await this.options.registry.load();
    return sessions.find((session) => session.id === sessionId);
  }

  async pickNextMetroPort(startPort = DEFAULT_METRO_PORT) {
    const sessions = await this.options.registry.load();
    const usedPorts = new Set(sessions.filter((session) => session.state !== "stopped").map((s) => s.metroPort));
    let port = startPort;

    while (usedPorts.has(port)) {
      port += 1;
    }

    return port;
  }

  static disconnectedTunnel(): TunnelState {
    return {
      connected: false,
      provider: "none",
    };
  }
}
