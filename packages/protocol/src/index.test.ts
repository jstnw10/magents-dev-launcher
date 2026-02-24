import { describe, expect, it } from "bun:test";

import {
  CONTRACT_VERSIONING_POLICY,
  PROTOCOL_VERSION,
  isCompatibleProtocolVersion,
  type CommandEnvelope,
  type CommandResultEnvelope,
  type EventEnvelope,
} from "./index";

describe("protocol contracts", () => {
  it("documents major-version compatibility policy", () => {
    expect(CONTRACT_VERSIONING_POLICY.current).toBe(PROTOCOL_VERSION);
    expect(CONTRACT_VERSIONING_POLICY.compatibility).toBe("major-equals");
    expect(isCompatibleProtocolVersion(PROTOCOL_VERSION)).toBe(true);
    expect(isCompatibleProtocolVersion(PROTOCOL_VERSION + 1)).toBe(false);
  });

  it("types command and response envelopes", () => {
    const request: CommandEnvelope<"session.create"> = {
      protocolVersion: PROTOCOL_VERSION,
      correlationId: "req-1",
      command: "session.create",
      payload: {
        label: "Device A",
        projectRoot: "/tmp/worktree-a",
        metroPort: 8081,
      },
    };

    const response: CommandResultEnvelope<"session.create"> = {
      protocolVersion: PROTOCOL_VERSION,
      correlationId: request.correlationId,
      command: request.command,
      ok: true,
      payload: {
        session: {
          id: "sess-1",
          label: request.payload.label,
          projectRoot: request.payload.projectRoot,
          metroUrl: "http://127.0.0.1:8081",
          state: "running",
        },
      },
    };

    expect(response.ok).toBe(true);
    expect(response.payload.session.label).toBe("Device A");
  });

  it("types event envelopes", () => {
    const event: EventEnvelope<"session.log"> = {
      protocolVersion: PROTOCOL_VERSION,
      event: "session.log",
      occurredAt: new Date().toISOString(),
      payload: {
        sessionId: "sess-1",
        entry: {
          level: "info",
          message: "Metro ready",
          timestamp: new Date().toISOString(),
        },
      },
    };

    expect(event.payload.entry.message).toBe("Metro ready");
  });
});
