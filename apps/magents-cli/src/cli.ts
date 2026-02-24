#!/usr/bin/env bun

import { ControlClient, CommandError } from "@magents/sdk";

import { LocalControlTransport } from "./control-transport";
import { SessionOrchestrator } from "./orchestrator";
import { SystemPortAllocator } from "./port-allocator";
import { FileSessionRegistry } from "./registry";
import { CloudflareTunnelManager } from "./tunnel";
import { OrchestrationError, type TunnelConfig } from "./types";
import { GitWorktreeManager } from "./worktree";

export interface CliDependencies {
  readonly controlClient: ControlClient;
  readonly orchestrator: SessionOrchestrator;
  readonly cwd: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

function parseValue(args: readonly string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new OrchestrationError("INVALID_ARGUMENT", `Flag ${flag} requires a value.`);
  }

  return value;
}

function parseBoolean(args: readonly string[], flag: string) {
  return args.includes(flag);
}

function parsePort(args: readonly string[], flag: string) {
  const value = parseValue(args, flag);
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new OrchestrationError("INVALID_ARGUMENT", `Flag ${flag} must be a positive integer.`);
  }

  return parsed;
}

function parseTunnelConfig(args: readonly string[]): TunnelConfig | undefined {
  const tunnelName = parseValue(args, "--tunnel-name");
  const domain = parseValue(args, "--domain");

  if (tunnelName && domain) {
    return { mode: "named", tunnelName, domain };
  }

  if (tunnelName || domain) {
    throw new OrchestrationError(
      "INVALID_ARGUMENT",
      "Both --tunnel-name and --domain must be provided for named tunnel mode.",
    );
  }

  return undefined;
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function requireValue(args: readonly string[], flag: string) {
  const value = parseValue(args, flag);
  if (!value) {
    throw new OrchestrationError("INVALID_ARGUMENT", `Missing required flag ${flag}.`);
  }
  return value;
}

function createDefaultDeps(): CliDependencies {
  const registry = new FileSessionRegistry();
  const orchestrator = new SessionOrchestrator({
    registry,
    worktrees: new GitWorktreeManager(),
    tunnels: new CloudflareTunnelManager(),
    ports: new SystemPortAllocator(registry),
  });
  const controlClient = new ControlClient(new LocalControlTransport(orchestrator));
  return {
    orchestrator,
    controlClient,
    cwd: process.cwd(),
    stdout: (line) => {
      console.log(line);
    },
    stderr: (line) => {
      console.error(line);
    },
  };
}

export async function runCli(argv: string[], deps: CliDependencies = createDefaultDeps()) {
  if (argv.length === 0) {
    deps.stderr("Usage: magents <session|worktree|tunnel> <command> [options]");
    return 1;
  }

  const [group, command, ...args] = argv;

  try {
    switch (group) {
      case "session": {
        if (command === "start") {
          const label = parseValue(args, "--label") ?? `session-${Date.now()}`;
          const projectRoot = parseValue(args, "--project-root") ?? deps.cwd;
          const metroPort = parsePort(args, "--metro-port");
          const tunnelEnabled = parseBoolean(args, "--tunnel");
          const tunnelConfig = parseTunnelConfig(args);
          const resolvedMetroPort = metroPort ?? (await deps.orchestrator.allocatePort());
          const result = await deps.orchestrator.createSession({
            label,
            projectRoot,
            metroPort: resolvedMetroPort,
            tunnelEnabled,
            tunnelConfig,
          });
          deps.stdout(json(result));
          return 0;
        }

        if (command === "stop") {
          const sessionId = requireValue(args, "--session-id");
          const result = await deps.controlClient.stopSession({
            sessionId,
          });
          deps.stdout(json(result));
          return 0;
        }

        if (command === "list") {
          const result = await deps.controlClient.listSessions();
          deps.stdout(json(result));
          return 0;
        }

        if (command === "endpoint") {
          const sessionId = requireValue(args, "--session-id");
          const result = await deps.controlClient.resolveEndpoint({
            sessionId,
          });
          deps.stdout(json(result));
          return 0;
        }

        break;
      }
      case "worktree": {
        if (command === "provision") {
          const sessionId = requireValue(args, "--session-id");
          const sourceRoot = parseValue(args, "--source-root");
          const requestedPath = parseValue(args, "--path");
          const result = await deps.orchestrator.provisionWorktree({
            sessionId,
            sourceRoot,
            path: requestedPath,
          });
          deps.stdout(json(result));
          return 0;
        }

        if (command === "cleanup") {
          const sessionId = requireValue(args, "--session-id");
          const result = await deps.orchestrator.cleanupWorktree({
            sessionId,
          });
          deps.stdout(json(result));
          return 0;
        }

        break;
      }
      case "tunnel": {
        if (command === "attach") {
          const sessionId = requireValue(args, "--session-id");
          const publicUrl = parseValue(args, "--public-url");
          const tunnelConfig = parseTunnelConfig(args);
          const result = await deps.orchestrator.attachTunnel({
            sessionId,
            publicUrl,
            tunnelConfig,
          });
          deps.stdout(json(result));
          return 0;
        }

        if (command === "detach") {
          const sessionId = requireValue(args, "--session-id");
          const result = await deps.orchestrator.detachTunnel({
            sessionId,
          });
          deps.stdout(json(result));
          return 0;
        }

        if (command === "list") {
          const tunnels = deps.orchestrator.listTunnels();
          deps.stdout(json({ tunnels }));
          return 0;
        }

        if (command === "status") {
          const sessionId = requireValue(args, "--session-id");
          const tunnel = deps.orchestrator.getTunnelStatus(sessionId);
          if (!tunnel) {
            throw new OrchestrationError(
              "TUNNEL_NOT_FOUND",
              `No active tunnel for session ${sessionId}.`,
            );
          }
          deps.stdout(json({ tunnel }));
          return 0;
        }

        break;
      }
      default:
        break;
    }

    deps.stderr(`Unknown command: ${argv.join(" ")}`);
    return 1;
  } catch (error) {
    if (error instanceof CommandError) {
      deps.stderr(`${error.details.code}: ${error.details.message}`);
      return 1;
    }

    if (error instanceof OrchestrationError) {
      deps.stderr(`${error.code}: ${error.message}`);
      return 1;
    }

    deps.stderr(error instanceof Error ? error.message : "Unknown CLI failure.");
    return 1;
  }
}

if (import.meta.main) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
