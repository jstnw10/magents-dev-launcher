import { describe, expect, it } from "bun:test";

import { LauncherClient, createLauncherClient, selectSession, type LauncherClientOptions } from "./index";

describe("@magents/dev-launcher public API", () => {
  it("wraps shared sdk commands and resolves launch urls", async () => {
    const recordedCommands: string[] = [];
    const options: LauncherClientOptions = {
      defaultSessionId: "sess-1",
      correlationIdFactory: () => "corr-fixed",
      transport: {
        async send(request) {
          recordedCommands.push(request.command);

          if (request.command === "session.list") {
            return {
              protocolVersion: request.protocolVersion,
              correlationId: request.correlationId,
              command: request.command,
              ok: true,
              payload: {
                sessions: [
                  {
                    id: "sess-1",
                    label: "Default",
                    projectRoot: "/tmp/worktree-default",
                    metroUrl: "http://127.0.0.1:8081",
                    state: "running",
                  },
                ],
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
                  publicUrl: "https://launcher.example.trycloudflare.com",
                  provider: "cloudflare",
                },
              },
            };
          }

          if (request.command === "session.create") {
            return {
              protocolVersion: request.protocolVersion,
              correlationId: request.correlationId,
              command: request.command,
              ok: true,
              payload: {
                session: {
                  id: "sess-2",
                  label: request.payload.label,
                  projectRoot: request.payload.projectRoot,
                  metroUrl: `http://127.0.0.1:${request.payload.metroPort}`,
                  state: "running",
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
      },
    };

    const client = createLauncherClient(options);
    const sessions = await client.listSessions();
    const launchUrl = await client.resolveLaunchUrl();

    expect(sessions.sessions).toHaveLength(1);
    expect(launchUrl).toBe("https://launcher.example.trycloudflare.com");
    expect(recordedCommands).toEqual(["session.list", "session.resolveEndpoint"]);
  });

  it("requires explicit session id when default is not configured", async () => {
    const client = new LauncherClient({
      transport: {
        async send() {
          throw new Error("transport should not be called");
        },
      },
    });

    await expect(client.resolveEndpoint()).rejects.toThrow(
      "A sessionId is required. Set defaultSessionId or pass one explicitly."
    );
  });

  it("selects preferred session and falls back to first running session", () => {
    const sessions = [
      {
        id: "sess-a",
        label: "A",
        projectRoot: "/tmp/worktree-a",
        metroUrl: "http://127.0.0.1:8081",
        state: "stopped",
      },
      {
        id: "sess-b",
        label: "B",
        projectRoot: "/tmp/worktree-b",
        metroUrl: "http://127.0.0.1:8082",
        state: "running",
      },
    ] as const;

    expect(selectSession(sessions, { preferredSessionId: "sess-a" })?.id).toBe("sess-a");
    expect(selectSession(sessions, { preferredSessionId: "missing" })?.id).toBe("sess-b");
    expect(selectSession([], { preferredSessionId: "missing" })).toBeUndefined();
  });
});
