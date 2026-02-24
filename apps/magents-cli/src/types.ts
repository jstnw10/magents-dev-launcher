import type {
  CommandFailure,
  SessionId,
  SessionSummary,
  SessionState,
  TunnelState,
} from "@magents/protocol";

export const DEFAULT_METRO_PORT = 8081;

export interface SessionRecord {
  readonly id: SessionId;
  readonly label: string;
  projectRoot: string;
  readonly metroPort: number;
  state: SessionState;
  tunnel: TunnelState;
  worktree?: {
    readonly sourceRoot: string;
    readonly path: string;
  };
}

export interface SessionRegistry {
  load(): Promise<SessionRecord[]>;
  save(sessions: SessionRecord[]): Promise<void>;
}

export interface WorktreeManager {
  provision(input: {
    sessionId: SessionId;
    sourceRoot: string;
    requestedPath?: string;
  }): Promise<string>;
  cleanup(input: {
    sourceRoot: string;
    path: string;
  }): Promise<void>;
}

export interface TunnelManager {
  attach(input: {
    sessionId: SessionId;
    metroPort: number;
    publicUrl?: string;
  }): Promise<TunnelState>;
  detach(input: {
    sessionId: SessionId;
  }): Promise<TunnelState>;
}

export interface SessionOrchestratorOptions {
  readonly registry: SessionRegistry;
  readonly worktrees: WorktreeManager;
  readonly tunnels: TunnelManager;
  readonly idFactory?: () => SessionId;
}

export class OrchestrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OrchestrationError";
    this.code = code;
  }
}

export function createSessionSummary(record: SessionRecord): SessionSummary {
  return {
    id: record.id,
    label: record.label,
    projectRoot: record.projectRoot,
    metroUrl: `http://127.0.0.1:${record.metroPort}`,
    tunnelUrl: record.tunnel.publicUrl,
    state: record.state,
  };
}

export function toCommandFailure(error: unknown): CommandFailure {
  if (error instanceof OrchestrationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "Unknown failure.",
    retryable: false,
  };
}
