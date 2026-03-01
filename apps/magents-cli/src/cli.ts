#!/usr/bin/env bun

import { ControlClient, CommandError } from "@magents/sdk";

import { LocalControlTransport } from "./control-transport";
import { readGlobalConfig } from "./global-config";
import { handleInit } from "./init";
import { handleLink, createDefaultLinkDeps } from "./link";
import {
  resolveOpencodePath,
  setOpencodePath,
  detectOpencodePath,
  getOpencodeVersion,
  type OpencodeResolverDeps,
} from "./opencode-resolver";
import { SessionOrchestrator } from "./orchestrator";
import { SystemPortAllocator } from "./port-allocator";
import { FileSessionRegistry } from "./registry";
import { CloudflareTunnelManager } from "./tunnel";
import { ConvexWorkspaceSync } from "./convex-sync";
import { OrchestrationError, type TunnelConfig } from "./types";
import { GitWorktreeManager } from "./worktree";
import { WorkspaceManager } from "./workspace-manager";
import { AgentManager } from "./agent-manager";
import { SpecialistRegistry, type InteractiveIO } from "./specialist-registry";
import { OpenCodeServer } from "./opencode-server";
import { createOpenCodeClient } from "./opencode-client";
import { createMcpServer } from "./mcp/server";
import { AgentServer, DEFAULT_AGENT_SERVER_PORT } from "./agent-server";

export interface AgentDeps {
  readonly server: Pick<OpenCodeServer, "start" | "stop" | "status" | "getOrStart">;
  readonly createManager: (serverUrl: string) => AgentManager;
}

export interface SpecialistDeps {
  readonly registry: SpecialistRegistry;
  readonly io?: InteractiveIO;
}

export interface CliDependencies {
  readonly controlClient: ControlClient;
  readonly orchestrator: SessionOrchestrator;
  readonly workspaceManager: WorkspaceManager;
  readonly syncEnabled: boolean;
  readonly cwd: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly opencodeResolverDeps?: Partial<OpencodeResolverDeps>;
  readonly agentDeps?: AgentDeps;
  readonly specialistDeps?: SpecialistDeps;
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
    resolvedDeps.stderr("Usage: magents <session|worktree|tunnel|workspace|opencode|agent|specialist|mcp|init|link> <command> [options]");
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
      case "opencode": {
        const resolverDeps = resolvedDeps.opencodeResolverDeps;

        if (command === "status") {
          const result = await resolveOpencodePath(resolverDeps);
          resolvedDeps.stdout(json(result));
          return 0;
        }

        if (command === "set-path") {
          const binaryPath = requireValue(args, "--path");
          const result = await setOpencodePath(binaryPath, resolverDeps);
          resolvedDeps.stdout(json({ ...result, saved: true }));
          return 0;
        }

        if (command === "detect") {
          const detected = await detectOpencodePath(resolverDeps);
          if (!detected) {
            throw new OrchestrationError(
              "OPENCODE_NOT_FOUND",
              "opencode is not installed or not found in PATH.",
            );
          }
          const version = await getOpencodeVersion(detected, resolverDeps);
          resolvedDeps.stdout(json({ path: detected, version }));
          return 0;
        }

        break;
      }
      case "agent": {
        const workspacePath = parseValue(args, "--workspace-path") ?? resolvedDeps.cwd;
        const agentDeps = resolvedDeps.agentDeps ?? {
          server: new OpenCodeServer(),
          createManager: (serverUrl: string) => new AgentManager({ client: createOpenCodeClient(serverUrl) }),
        };
        const server = agentDeps.server;
        const specialistRegistry = resolvedDeps.specialistDeps?.registry ?? new SpecialistRegistry();

        if (command === "server-start") {
          const info = await server.start(workspacePath);
          resolvedDeps.stdout(json(info));
          return 0;
        }

        if (command === "server-stop") {
          await server.stop(workspacePath);
          resolvedDeps.stdout(json({ stopped: true }));
          return 0;
        }

        if (command === "server-status") {
          const result = await server.status(workspacePath);
          resolvedDeps.stdout(json(result));
          return 0;
        }

        if (command === "manager-start") {
          const port = parseInt(parseValue(args, "--port") ?? String(DEFAULT_AGENT_SERVER_PORT), 10);
          const serverInfo = await server.getOrStart(workspacePath);
          const mgr = agentDeps.createManager(serverInfo.url);
          const agentServer = new AgentServer({
            workspacePath,
            manager: mgr,
            openCodeUrl: serverInfo.url,
            port,
          });
          const info = await agentServer.start();
          resolvedDeps.stdout(json(info));
          // Keep process alive
          await new Promise(() => {});
          return 0;
        }

        if (command === "manager-stop") {
          // Read server info and signal stop
          const infoPath = `${workspacePath}/.workspace/agent-manager/server.json`;
          try {
            const file = Bun.file(infoPath);
            if (await file.exists()) {
              await file.delete();
            }
          } catch {
            // Already gone
          }
          resolvedDeps.stdout(json({ stopped: true }));
          return 0;
        }

        if (command === "create") {
          const specialistName = parseValue(args, "--specialist");
          let label = parseValue(args, "--label");
          let model = parseValue(args, "--model");
          let specialistId: string | undefined;
          let systemPrompt: string | undefined;

          if (specialistName) {
            const specialist = await specialistRegistry.get(specialistName);
            if (!specialist) {
              const available = await specialistRegistry.list();
              const names = available.map((s) => s.id).join(", ");
              throw new OrchestrationError(
                "SPECIALIST_NOT_FOUND",
                `Specialist "${specialistName}" not found. Available: ${names}`,
              );
            }
            label = label ?? specialist.name;
            model = model ?? specialist.defaultModel;
            specialistId = specialistName;
            systemPrompt = specialist.systemPrompt;
          }

          if (!label) {
            throw new OrchestrationError("INVALID_ARGUMENT", "Missing required flag --label.");
          }

          const serverInfo = await server.getOrStart(workspacePath);
          const mgr = agentDeps.createManager(serverInfo.url);
          const metadata = await mgr.createAgent(workspacePath, {
            label,
            model,
            agent: specialistName,
            specialistId,
            systemPrompt,
          });
          resolvedDeps.stdout(json(metadata));
          return 0;
        }

        if (command === "list") {
          const serverInfo = await server.getOrStart(workspacePath);
          const mgr = agentDeps.createManager(serverInfo.url);
          const agents = await mgr.listAgents(workspacePath);
          resolvedDeps.stdout(json({ agents }));
          return 0;
        }

        if (command === "send") {
          const agentId = requireValue(args, "--agent-id");
          const message = requireValue(args, "--message");
          const serverInfo = await server.getOrStart(workspacePath);
          const mgr = agentDeps.createManager(serverInfo.url);
          const response = await mgr.sendMessage(workspacePath, agentId, message);
          resolvedDeps.stdout(json(response));
          return 0;
        }

        if (command === "conversation") {
          const agentId = requireValue(args, "--agent-id");
          const serverInfo = await server.getOrStart(workspacePath);
          const mgr = agentDeps.createManager(serverInfo.url);
          const conversation = await mgr.getConversation(workspacePath, agentId);
          resolvedDeps.stdout(json(conversation));
          return 0;
        }

        if (command === "remove") {
          const agentId = requireValue(args, "--agent-id");
          const serverInfo = await server.getOrStart(workspacePath);
          const mgr = agentDeps.createManager(serverInfo.url);
          await mgr.removeAgent(workspacePath, agentId);
          resolvedDeps.stdout(json({ removed: true, agentId }));
          return 0;
        }

        break;
      }
      case "specialist": {
        const specialistRegistry = resolvedDeps.specialistDeps?.registry ?? new SpecialistRegistry();

        if (command === "list") {
          const specialists = await specialistRegistry.list();
          const lines = ["  ID             NAME           SOURCE    DESCRIPTION"];
          for (const spec of specialists) {
            lines.push(
              `  ${spec.id.padEnd(14)} ${spec.name.padEnd(14)} ${spec.source.padEnd(9)} ${spec.description}`,
            );
          }
          resolvedDeps.stdout(lines.join("\n"));
          return 0;
        }

        if (command === "add") {
          const io = resolvedDeps.specialistDeps?.io;
          if (!io) {
            throw new OrchestrationError(
              "NO_INTERACTIVE_IO",
              "Interactive IO is required for specialist add.",
            );
          }

          const template = `---\nname: ""\ndescription: ""\nmodelTier: "smart"\n---\n\nWrite your system prompt here...\n`;
          const content = await io.openEditor(template);
          if (!content.trim()) {
            throw new OrchestrationError("ABORTED", "Specialist content is empty. Aborting.");
          }

          const id = await io.prompt("Specialist ID (e.g. my-reviewer):");
          if (!id.trim()) {
            throw new OrchestrationError("INVALID_ARGUMENT", "Specialist ID cannot be empty.");
          }

          const confirmed = await io.confirm(`Save specialist "${id.trim()}"?`);
          if (!confirmed) {
            resolvedDeps.stdout("Aborted.");
            return 0;
          }

          await specialistRegistry.add(id.trim(), content);
          resolvedDeps.stdout(json({ added: true, id: id.trim() }));
          return 0;
        }

        if (command === "remove") {
          const name = parseValue(args, "--name");
          if (!name) {
            throw new OrchestrationError("INVALID_ARGUMENT", "Missing required flag --name.");
          }
          await specialistRegistry.remove(name);
          resolvedDeps.stdout(json({ removed: true, name }));
          return 0;
        }

        break;
      }
      case "mcp": {
        if (command === "serve") {
          const workspacePath = parseValue(args, "--workspace-path") ?? resolvedDeps.cwd;
          const openCodeServer = resolvedDeps.agentDeps?.server ?? new OpenCodeServer();
          const createManager = resolvedDeps.agentDeps?.createManager ?? ((url: string) => new AgentManager({ client: createOpenCodeClient(url) }));
          const specialistRegistry = resolvedDeps.specialistDeps?.registry ?? new SpecialistRegistry();

          const server = createMcpServer(workspacePath, {
            getAgentManager: async () => {
              const serverInfo = await openCodeServer.getOrStart(workspacePath);
              const manager = createManager(serverInfo.url);
              return { manager, serverUrl: serverInfo.url };
            },
            specialistRegistry,
          });
          await server.start();
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
