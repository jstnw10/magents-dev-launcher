import type { CommandMap, SessionId, SessionSummary, TunnelState } from "@magents/protocol";
import { ControlClient, type ControlClientOptions, type ControlTransport } from "@magents/sdk";

export type LauncherSession = SessionSummary;

export interface LauncherEndpoint {
  readonly sessionId: SessionId;
  readonly metroUrl: string;
  readonly tunnel: TunnelState;
}

export interface SessionSelectionOptions {
  readonly preferredSessionId?: SessionId;
  readonly fallbackToFirstRunning?: boolean;
}

export interface LauncherClientOptions extends ControlClientOptions {
  readonly transport: ControlTransport;
  readonly defaultSessionId?: SessionId;
}

export class LauncherClient {
  readonly defaultSessionId?: SessionId;

  private readonly controlClient: ControlClient;

  constructor({ transport, defaultSessionId, ...options }: LauncherClientOptions) {
    this.controlClient = new ControlClient(transport, options);
    this.defaultSessionId = defaultSessionId;
  }

  async createSession(request: CommandMap["session.create"]["request"]) {
    return this.controlClient.createSession(request);
  }

  async listSessions() {
    return this.controlClient.listSessions();
  }

  async stopSession(request: CommandMap["session.stop"]["request"]) {
    return this.controlClient.stopSession(request);
  }

  async resolveEndpoint(sessionId = this.requireSessionId()): Promise<LauncherEndpoint> {
    return this.controlClient.resolveEndpoint({ sessionId });
  }

  async resolveLaunchUrl(sessionId = this.requireSessionId()) {
    const endpoint = await this.resolveEndpoint(sessionId);

    return endpoint.tunnel.connected && endpoint.tunnel.publicUrl
      ? endpoint.tunnel.publicUrl
      : endpoint.metroUrl;
  }

  private requireSessionId() {
    if (!this.defaultSessionId) {
      throw new Error("A sessionId is required. Set defaultSessionId or pass one explicitly.");
    }

    return this.defaultSessionId;
  }
}

export function createLauncherClient(options: LauncherClientOptions) {
  return new LauncherClient(options);
}

export function selectSession(
  sessions: readonly SessionSummary[],
  options: SessionSelectionOptions = {}
): SessionSummary | undefined {
  const { preferredSessionId, fallbackToFirstRunning = true } = options;

  if (preferredSessionId) {
    const preferred = sessions.find((session) => session.id === preferredSessionId);
    if (preferred) {
      return preferred;
    }
  }

  if (fallbackToFirstRunning) {
    const running = sessions.find((session) => session.state === "running");
    if (running) {
      return running;
    }
  }

  return sessions[0];
}
