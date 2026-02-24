import {
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type CommandMap,
  type CommandName,
  type CommandResultEnvelope,
} from "@magents/protocol";
import type { ControlTransport } from "@magents/sdk";

import { SessionOrchestrator } from "./orchestrator";
import { toCommandFailure } from "./types";

export class LocalControlTransport implements ControlTransport {
  constructor(private readonly orchestrator: SessionOrchestrator) {}

  async send<TCommand extends CommandName>(
    request: CommandEnvelope<TCommand>
  ): Promise<CommandResultEnvelope<TCommand>> {
    try {
      switch (request.command) {
        case "session.create": {
          const payload = await this.orchestrator.createSession(
            request.payload as CommandMap["session.create"]["request"]
          );
          return this.ok(request, payload);
        }
        case "session.list": {
          const payload = await this.orchestrator.listSessions();
          return this.ok(request, payload);
        }
        case "session.stop": {
          const payload = await this.orchestrator.stopSession(
            request.payload as CommandMap["session.stop"]["request"]
          );
          return this.ok(request, payload);
        }
        case "session.resolveEndpoint": {
          const payload = await this.orchestrator.resolveEndpoint(
            request.payload as CommandMap["session.resolveEndpoint"]["request"]
          );
          return this.ok(request, payload);
        }
      }

      return {
        protocolVersion: PROTOCOL_VERSION,
        correlationId: request.correlationId,
        command: request.command,
        ok: false,
        error: {
          code: "UNSUPPORTED_COMMAND",
          message: `Unsupported command: ${request.command}`,
          retryable: false,
        },
      } as CommandResultEnvelope<TCommand>;
    } catch (error) {
      return {
        protocolVersion: PROTOCOL_VERSION,
        correlationId: request.correlationId,
        command: request.command,
        ok: false,
        error: toCommandFailure(error),
      } as CommandResultEnvelope<TCommand>;
    }
  }

  private ok<TCommand extends CommandName>(
    request: CommandEnvelope<TCommand>,
    payload: CommandMap[TCommand]["response"]
  ) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      correlationId: request.correlationId,
      command: request.command,
      ok: true,
      payload,
    } as CommandResultEnvelope<TCommand>;
  }
}
