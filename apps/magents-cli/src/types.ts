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

export interface WorktreeInfo {
  readonly worktree: string;
  readonly HEAD: string;
  readonly branch: string;
  readonly bare: boolean;
  readonly detached: boolean;
}

export interface WorktreeManager {
  provision(input: {
    sessionId: SessionId;
    sourceRoot: string;
    requestedPath?: string;
    baseRef?: string;
  }): Promise<string>;
  cleanup(input: {
    sourceRoot: string;
    path: string;
    force?: boolean;
  }): Promise<void>;
  list(sourceRoot: string): Promise<WorktreeInfo[]>;
  exists(worktreePath: string): Promise<boolean>;
}

export type TunnelConfig =
  | { mode: "quick" }
  | { mode: "named"; tunnelName: string; domain: string };

export interface TunnelInfo {
  readonly sessionId: string;
  readonly publicUrl: string;
  readonly metroPort: number;
  readonly config: TunnelConfig;
}

export interface TunnelManager {
  attach(input: {
    sessionId: SessionId;
    metroPort: number;
    publicUrl?: string;
    tunnelConfig?: TunnelConfig;
  }): Promise<TunnelState>;
  detach(input: {
    sessionId: SessionId;
  }): Promise<TunnelState>;
  list(): TunnelInfo[];
  getStatus(sessionId: SessionId): TunnelInfo | undefined;
}

export interface PortAllocator {
  allocate(): Promise<number>;
  release(port: number): void;
}

export interface SessionOrchestratorOptions {
  readonly registry: SessionRegistry;
  readonly worktrees: WorktreeManager;
  readonly tunnels: TunnelManager;
  readonly ports?: PortAllocator;
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

export type WorkspaceStatus = "active" | "archived";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export interface WorkspaceConfig {
  id: string;
  title: string;
  branch: string;
  baseRef: string;
  baseCommitSha: string;
  status: WorkspaceStatus;
  createdAt: string;
  updatedAt: string;
  path: string;
  repositoryPath: string;
  repositoryOwner?: string;
  repositoryName?: string;
  worktreePath: string;
  tags: string[];
  archived?: boolean;
  archivedAt?: string;
}

export interface WorkspaceCreateOptions {
  repositoryPath: string;
  title?: string;
  branch?: string;
  baseRef?: string;
  setupScript?: string;
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
