import { describe, expect, it } from "bun:test";

import { CommandError, ControlClient, type ControlTransport } from "./index";

describe("ControlClient", () => {
  it("sends typed session commands through the transport", async () => {
    const recordedCommands: string[] = [];
    const transport: ControlTransport = {
      async send(request) {
        recordedCommands.push(request.command);

        if (request.command === "session.create") {
          return {
            protocolVersion: request.protocolVersion,
            correlationId: request.correlationId,
            command: request.command,
            ok: true,
            payload: {
              session: {
                id: "sess-1",
                label: request.payload.label,
                projectRoot: request.payload.projectRoot,
                metroUrl: `http://127.0.0.1:${request.payload.metroPort}`,
                state: "running",
              },
            },
          };
        }

        if (request.command === "session.list") {
          return {
            protocolVersion: request.protocolVersion,
            correlationId: request.correlationId,
            command: request.command,
            ok: true,
            payload: {
              sessions: [],
            },
          };
        }

        if (request.command === "session.resolveEndpoint") {
          return {
            protocolVersion: request.protocolVersion,
            correlationId: request.correlationId,
            command: request.command,
            ok: true,
            payload: {
              sessionId: request.payload.sessionId,
              metroUrl: "http://127.0.0.1:8081",
              tunnel: {
                connected: true,
                publicUrl: "https://example.trycloudflare.com",
                provider: "cloudflare",
              },
            },
          };
        }

        return {
          protocolVersion: request.protocolVersion,
          correlationId: request.correlationId,
          command: request.command,
          ok: true,
          payload: {
            sessionId: request.payload.sessionId,
            stopped: true,
          },
        };
      },
    };

    const client = new ControlClient(transport, {
      correlationIdFactory: () => "corr-fixed",
    });

    const createResult = await client.createSession({
      label: "iPhone",
      projectRoot: "/tmp/worktree-a",
      metroPort: 8081,
    });

    const listResult = await client.listSessions();
    const endpointResult = await client.resolveEndpoint({ sessionId: "sess-1" });

    expect(createResult.session.label).toBe("iPhone");
    expect(listResult.sessions).toHaveLength(0);
    expect(endpointResult.tunnel.connected).toBe(true);
    expect(recordedCommands).toEqual(["session.create", "session.list", "session.resolveEndpoint"]);
  });

  it("throws CommandError when transport returns protocol failure", async () => {
    const transport: ControlTransport = {
      async send(request) {
        return {
          protocolVersion: request.protocolVersion,
          correlationId: request.correlationId,
          command: request.command,
          ok: false,
          error: {
            code: "SESSION_NOT_FOUND",
            message: "Session not found",
          },
        };
      },
    };

    const client = new ControlClient(transport, {
      correlationIdFactory: () => "corr-fixed",
    });

    const pending = client.stopSession({ sessionId: "missing-session" });

    await expect(pending).rejects.toBeInstanceOf(CommandError);
  });

  it("subscribes to typed events through the transport", () => {
    const logs: string[] = [];

    const transport: ControlTransport = {
      async send(request) {
        return {
          protocolVersion: request.protocolVersion,
          correlationId: request.correlationId,
          command: request.command,
          ok: true,
          payload: {
            sessions: [],
          },
        } as never;
      },
      subscribe(event, listener) {
        if (event === "session.log") {
          listener({
            protocolVersion: 1,
            event,
            occurredAt: new Date().toISOString(),
            payload: {
              sessionId: "sess-1",
              entry: {
                level: "info",
                message: "ready",
                timestamp: new Date().toISOString(),
              },
            },
          });
        }

        return () => {
          logs.push("unsubscribed");
        };
      },
    };

    const client = new ControlClient(transport);
    const unsubscribe = client.onEvent("session.log", ({ entry }) => {
      logs.push(entry.message);
    });

    unsubscribe();

    expect(logs).toEqual(["ready", "unsubscribed"]);
  });
});
