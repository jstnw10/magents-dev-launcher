#!/usr/bin/env bun

import { ControlClient, CommandError } from "@magents/sdk";

import { LocalControlTransport } from "./control-transport";
import { readGlobalConfig } from "./global-config";
import { handleInit } from "./init";
import { handleLink, createDefaultLinkDeps } from "./link";
import { SessionOrchestrator } from "./orchestrator";
import { SystemPortAllocator } from "./port-allocator";
import { FileSessionRegistry } from "./registry";
import { CloudflareTunnelManager } from "./tunnel";
import { ConvexWorkspaceSync } from "./convex-sync";
import { OrchestrationError, type TunnelConfig } from "./types";
import { GitWorktreeManager } from "./worktree";
import { WorkspaceManager } from "./workspace-manager";

export interface CliDependencies {
  readonly controlClient: ControlClient;
  readonly orchestrator: SessionOrchestrator;
  readonly workspaceManager: WorkspaceManager;
  readonly syncEnabled: boolean;
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

async function createDefaultDeps(): Promise<CliDependencies> {
  const registry = new FileSessionRegistry();
  const worktrees = new GitWorktreeManager();
  const orchestrator = new SessionOrchestrator({
    registry,
    worktrees,
    tunnels: new CloudflareTunnelManager(),
    ports: new SystemPortAllocator(registry),
  });
  const controlClient = new ControlClient(new LocalControlTransport(orchestrator));
  const globalConfig = await readGlobalConfig();
  const convexUrl = process.env.CONVEX_URL ?? globalConfig.convexUrl ?? "";
  const syncEnabled = convexUrl !== "";
  const sync = new ConvexWorkspaceSync({
    convexUrl,
    enabled: syncEnabled,
  });
  const workspaceManager = new WorkspaceManager({ worktrees, sync });
  return {
    orchestrator,
    controlClient,
    workspaceManager,
    syncEnabled,
    cwd: process.cwd(),
    stdout: (line) => {
      console.log(line);
    },
    stderr: (line) => {
      console.error(line);
    },
  };
}

export async function runCli(argv: string[], deps?: CliDependencies) {
  const resolvedDeps = deps ?? (await createDefaultDeps());

  if (argv.length === 0) {
    resolvedDeps.stderr("Usage: magents <session|worktree|tunnel|workspace|init|link> <command> [options]");
    return 1;
  }

  const [group, command, ...args] = argv;

  try {
    switch (group) {
      case "init": {
        const initArgs = command ? [command, ...args] : args;
        return await handleInit(initArgs, {
          stdout: resolvedDeps.stdout,
          stderr: resolvedDeps.stderr,
        });
      }
      case "link": {
        const linkArgs = command ? [command, ...args] : args;
        const linkDeps = createDefaultLinkDeps();
        return await handleLink(linkArgs, linkDeps);
      }
      case "session": {
        if (command === "start") {
          const label = parseValue(args, "--label") ?? `session-${Date.now()}`;
          const projectRoot = parseValue(args, "--project-root") ?? resolvedDeps.cwd;
          const metroPort = parsePort(args, "--metro-port");
          const tunnelEnabled = parseBoolean(args, "--tunnel");
          const tunnelConfig = parseTunnelConfig(args);
          const resolvedMetroPort = metroPort ?? (await resolvedDeps.orchestrator.allocatePort());
          const result = await resolvedDeps.orchestrator.createSession({
            label,
            projectRoot,
            metroPort: resolvedMetroPort,
            tunnelEnabled,
            tunnelConfig,
          });
          resolvedDeps.stdout(json(result));
          return 0;
        }

        if (command === "stop") {
          const sessionId = requireValue(args, "--session-id");
          const result = await resolvedDeps.controlClient.stopSession({
            sessionId,
          });
          resolvedDeps.stdout(json(result));
          return 0;
        }

        if (command === "list") {
          const result = await resolvedDeps.controlClient.listSessions();
          resolvedDeps.stdout(json(result));
          return 0;
        }

        if (command === "endpoint") {
          const sessionId = requireValue(args, "--session-id");
          const result = await resolvedDeps.controlClient.resolveEndpoint({
            sessionId,
          });
          resolvedDeps.stdout(json(result));
          return 0;
        }

        break;
      }
      case "worktree": {
        if (command === "provision") {
          const sessionId = requireValue(args, "--session-id");
          const sourceRoot = parseValue(args, "--source-root");
          const requestedPath = parseValue(args, "--path");
          const result = await resolvedDeps.orchestrator.provisionWorktree({
            sessionId,
            sourceRoot,
            path: requestedPath,
          });
          resolvedDeps.stdout(json(result));
          return 0;
        }

        if (command === "cleanup") {
          const sessionId = requireValue(args, "--session-id");
          const result = await resolvedDeps.orchestrator.cleanupWorktree({
            sessionId,
          });
          resolvedDeps.stdout(json(result));
          return 0;
        }

        break;
      }
      case "tunnel": {
        if (command === "attach") {
          const sessionId = requireValue(args, "--session-id");
          const publicUrl = parseValue(args, "--public-url");
          const tunnelConfig = parseTunnelConfig(args);
          const result = await resolvedDeps.orchestrator.attachTunnel({
            sessionId,
            publicUrl,
            tunnelConfig,
          });
          resolvedDeps.stdout(json(result));
          return 0;
        }

        if (command === "detach") {
          const sessionId = requireValue(args, "--session-id");
          const result = await resolvedDeps.orchestrator.detachTunnel({
            sessionId,
          });
          resolvedDeps.stdout(json(result));
          return 0;
        }

        if (command === "list") {
          const tunnels = resolvedDeps.orchestrator.listTunnels();
          resolvedDeps.stdout(json({ tunnels }));
          return 0;
        }

        if (command === "status") {
          const sessionId = requireValue(args, "--session-id");
          const tunnel = resolvedDeps.orchestrator.getTunnelStatus(sessionId);
          if (!tunnel) {
            throw new OrchestrationError(
              "TUNNEL_NOT_FOUND",
              `No active tunnel for session ${sessionId}.`,
            );
          }
          resolvedDeps.stdout(json({ tunnel }));
          return 0;
        }

        break;
      }
      case "workspace": {
        if (command === "create") {
          const repo = requireValue(args, "--repo");
          const title = parseValue(args, "--title");
          const baseRef = parseValue(args, "--base-ref");
          const setupCommand = parseValue(args, "--setup-command");
          const result = await resolvedDeps.workspaceManager.create({
            repositoryPath: repo,
            title,
            baseRef,
            setupScript: setupCommand,
          });
          resolvedDeps.stdout(json(result));
          if (resolvedDeps.syncEnabled) resolvedDeps.stdout("Synced to cloud.");
          return 0;
        }

        if (command === "list") {
          const workspaces = await resolvedDeps.workspaceManager.list();
          resolvedDeps.stdout(json({ workspaces }));
          return 0;
        }

        if (command === "status") {
          const id = requireValue(args, "--id");
          const workspace = await resolvedDeps.workspaceManager.status(id);
          resolvedDeps.stdout(json({ workspace }));
          return 0;
        }

        if (command === "archive") {
          const id = requireValue(args, "--id");
          const workspace = await resolvedDeps.workspaceManager.archive(id);
          resolvedDeps.stdout(json({ workspace }));
          if (resolvedDeps.syncEnabled) resolvedDeps.stdout("Synced to cloud.");
          return 0;
        }

        if (command === "destroy") {
          const id = requireValue(args, "--id");
          const force = parseBoolean(args, "--force");
          await resolvedDeps.workspaceManager.destroy(id, { force });
          resolvedDeps.stdout(json({ destroyed: true, workspaceId: id }));
          if (resolvedDeps.syncEnabled) resolvedDeps.stdout("Synced to cloud.");
          return 0;
        }

        break;
      }
      default:
        break;
    }

    resolvedDeps.stderr(`Unknown command: ${argv.join(" ")}`);
    return 1;
  } catch (error) {
    if (error instanceof CommandError) {
      resolvedDeps.stderr(`${error.details.code}: ${error.details.message}`);
      return 1;
    }

    if (error instanceof OrchestrationError) {
      resolvedDeps.stderr(`${error.code}: ${error.message}`);
      return 1;
    }

    resolvedDeps.stderr(error instanceof Error ? error.message : "Unknown CLI failure.");
    return 1;
  }
}

if (import.meta.main) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
