import type {
  CommandEnvelope,
  CommandFailure,
  CommandMap,
  CommandName,
  CommandResultEnvelope,
  EventEnvelope,
  EventMap,
  EventName,
  ProtocolVersion,
} from "@magents/protocol";

const DEFAULT_PROTOCOL_VERSION = 1 as ProtocolVersion;

export interface ControlTransport {
  send<TCommand extends CommandName>(
    request: CommandEnvelope<TCommand>
  ): Promise<CommandResultEnvelope<TCommand>>;

  subscribe?<TEvent extends EventName>(
    event: TEvent,
    listener: (event: EventEnvelope<TEvent>) => void
  ): () => void;
}

export interface ControlClientOptions {
  readonly protocolVersion?: ProtocolVersion;
  readonly correlationIdFactory?: () => string;
}

export class CommandError<TCommand extends CommandName = CommandName> extends Error {
  readonly command: TCommand;
  readonly correlationId: string;
  readonly details: CommandFailure;

  constructor(response: Extract<CommandResultEnvelope<TCommand>, { ok: false }>) {
    super(response.error.message);
    this.name = "CommandError";
    this.command = response.command;
    this.correlationId = response.correlationId;
    this.details = response.error;
  }
}

export class ControlClient {
  readonly protocolVersion: ProtocolVersion;

  private readonly createCorrelationId: () => string;

  constructor(
    private readonly transport: ControlTransport,
    options: ControlClientOptions = {}
  ) {
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.createCorrelationId = options.correlationIdFactory ?? (() => `corr-${Date.now()}`);
  }

  async createSession(input: CommandMap["session.create"]["request"]) {
    return this.send("session.create", input);
  }

  async listSessions() {
    return this.send("session.list", {});
  }

  async stopSession(input: CommandMap["session.stop"]["request"]) {
    return this.send("session.stop", input);
  }

  async resolveEndpoint(input: CommandMap["session.resolveEndpoint"]["request"]) {
    return this.send("session.resolveEndpoint", input);
  }

  onEvent<TEvent extends EventName>(
    event: TEvent,
    listener: (payload: EventMap[TEvent]) => void
  ): () => void {
    if (!this.transport.subscribe) {
      throw new Error("Transport does not support subscriptions.");
    }

    return this.transport.subscribe(event, (envelope) => {
      listener(envelope.payload);
    });
  }

  async send<TCommand extends CommandName>(
    command: TCommand,
    payload: CommandMap[TCommand]["request"]
  ): Promise<CommandMap[TCommand]["response"]> {
    const response = await this.transport.send({
      protocolVersion: this.protocolVersion,
      correlationId: this.createCorrelationId(),
      command,
      payload,
    });

    if (!response.ok) {
      throw new CommandError(response);
    }

    return response.payload;
  }
}
