export const PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

export interface ContractVersioningPolicy {
  readonly current: ProtocolVersion;
  readonly compatibility: "major-equals";
  readonly additiveChange: "minor-compatible";
  readonly breakingChange: "major-bump";
}

export const CONTRACT_VERSIONING_POLICY: ContractVersioningPolicy = {
  current: PROTOCOL_VERSION,
  compatibility: "major-equals",
  additiveChange: "minor-compatible",
  breakingChange: "major-bump",
};

export function isCompatibleProtocolVersion(version: number): version is ProtocolVersion {
  return version === PROTOCOL_VERSION;
}

export type SessionId = string;

export type SessionState = "starting" | "running" | "stopped" | "error";

export interface SessionSummary {
  readonly id: SessionId;
  readonly label: string;
  readonly projectRoot: string;
  readonly metroUrl: string;
  readonly tunnelUrl?: string;
  readonly state: SessionState;
}

export interface TunnelState {
  readonly connected: boolean;
  readonly publicUrl?: string;
  readonly provider?: "cloudflare" | "none";
}

export interface SessionLogEntry {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly timestamp: string;
}

export interface CommandMap {
  readonly "session.create": {
    readonly request: {
      readonly label: string;
      readonly projectRoot: string;
      readonly metroPort: number;
      readonly tunnelEnabled?: boolean;
    };
    readonly response: {
      readonly session: SessionSummary;
    };
  };
  readonly "session.list": {
    readonly request: Record<string, never>;
    readonly response: {
      readonly sessions: readonly SessionSummary[];
    };
  };
  readonly "session.stop": {
    readonly request: {
      readonly sessionId: SessionId;
      readonly reason?: string;
    };
    readonly response: {
      readonly sessionId: SessionId;
      readonly stopped: boolean;
    };
  };
  readonly "session.resolveEndpoint": {
    readonly request: {
      readonly sessionId: SessionId;
    };
    readonly response: {
      readonly sessionId: SessionId;
      readonly metroUrl: string;
      readonly tunnel: TunnelState;
    };
  };
}

export type CommandName = keyof CommandMap;

export interface CommandEnvelope<TCommand extends CommandName = CommandName> {
  readonly protocolVersion: ProtocolVersion;
  readonly correlationId: string;
  readonly command: TCommand;
  readonly payload: CommandMap[TCommand]["request"];
}

export interface CommandFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}

export type CommandResultEnvelope<TCommand extends CommandName = CommandName> =
  | {
      readonly protocolVersion: ProtocolVersion;
      readonly correlationId: string;
      readonly command: TCommand;
      readonly ok: true;
      readonly payload: CommandMap[TCommand]["response"];
    }
  | {
      readonly protocolVersion: ProtocolVersion;
      readonly correlationId: string;
      readonly command: TCommand;
      readonly ok: false;
      readonly error: CommandFailure;
    };

export interface EventMap {
  readonly "session.created": {
    readonly session: SessionSummary;
  };
  readonly "session.updated": {
    readonly session: SessionSummary;
  };
  readonly "session.stopped": {
    readonly sessionId: SessionId;
    readonly reason?: string;
  };
  readonly "session.log": {
    readonly sessionId: SessionId;
    readonly entry: SessionLogEntry;
  };
}

export type EventName = keyof EventMap;

export interface EventEnvelope<TEvent extends EventName = EventName> {
  readonly protocolVersion: ProtocolVersion;
  readonly event: TEvent;
  readonly occurredAt: string;
  readonly payload: EventMap[TEvent];
}
