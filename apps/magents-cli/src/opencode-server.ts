import { mkdir } from "node:fs/promises";
import path from "node:path";

import { resolveOpencodePath, type ResolvedOpencode } from "./opencode-resolver";
import { OrchestrationError } from "./types";

export interface ServerInfo {
  pid: number;
  port: number;
  url: string;
  startedAt: string;
}

export interface OpenCodeServerOptions {
  resolveOpencode?: () => Promise<ResolvedOpencode>;
  allocatePort?: () => Promise<number>;
  timeout?: number;
  spawnProcess?: (cmd: string, args: string[], opts: SpawnOptions) => SpawnedProcess;
}

export interface SpawnOptions {
  stdout: "pipe";
  stderr: "pipe";
  env: Record<string, string | undefined>;
}

export interface SpawnedProcess {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number): void;
}

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_PORT = 4096;

function serverInfoPath(workspacePath: string): string {
  return path.join(workspacePath, ".workspace", "opencode", "server.json");
}

function opencodeDataDir(workspacePath: string): string {
  return path.join(workspacePath, ".workspace", "opencode", "data");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSpawnProcess(cmd: string, args: string[], opts: SpawnOptions): SpawnedProcess {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: opts.stdout,
    stderr: opts.stderr,
    env: opts.env,
  });
  return {
    pid: proc.pid,
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    exited: proc.exited,
    kill(signal?: number) {
      proc.kill(signal);
    },
  };
}

export class OpenCodeServer {
  private readonly resolveOpencode: () => Promise<ResolvedOpencode>;
  private readonly allocatePort: () => Promise<number>;
  private readonly timeout: number;
  private readonly spawnProcess: (cmd: string, args: string[], opts: SpawnOptions) => SpawnedProcess;

  constructor(options?: OpenCodeServerOptions) {
    this.resolveOpencode = options?.resolveOpencode ?? resolveOpencodePath;
    this.allocatePort = options?.allocatePort ?? (async () => DEFAULT_PORT);
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    this.spawnProcess = options?.spawnProcess ?? defaultSpawnProcess;
  }

  async start(workspacePath: string): Promise<ServerInfo> {
    const resolved = await this.resolveOpencode();
    const port = await this.allocatePort();
    const dataDir = opencodeDataDir(workspacePath);
    await mkdir(dataDir, { recursive: true });

    const args = ["serve", `--hostname=127.0.0.1`, `--port=${port}`];
    const proc = this.spawnProcess(resolved.path, args, {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENCODE_CONFIG_DIR: dataDir,
      },
    });

    const url = await this.waitForReady(proc, port);

    const info: ServerInfo = {
      pid: proc.pid,
      port,
      url,
      startedAt: new Date().toISOString(),
    };

    await this.persistServerInfo(workspacePath, info);
    return info;
  }

  async stop(workspacePath: string): Promise<void> {
    const info = await this.readServerInfo(workspacePath);
    if (!info) {
      return;
    }

    if (isPidAlive(info.pid)) {
      try {
        process.kill(info.pid);
      } catch {
        // Process may have exited between check and kill
      }
    }

    await this.removeServerInfo(workspacePath);
  }

  async status(workspacePath: string): Promise<{ running: boolean; info?: ServerInfo }> {
    const info = await this.readServerInfo(workspacePath);
    if (!info) {
      return { running: false };
    }

    if (isPidAlive(info.pid)) {
      return { running: true, info };
    }

    // Stale PID — clean up
    await this.removeServerInfo(workspacePath);
    return { running: false };
  }

  async getOrStart(workspacePath: string): Promise<ServerInfo> {
    const { running, info } = await this.status(workspacePath);
    if (running && info) {
      return info;
    }
    return this.start(workspacePath);
  }

  private async waitForReady(proc: SpawnedProcess, port: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill();
        reject(
          new OrchestrationError(
            "OPENCODE_SERVER_TIMEOUT",
            `Timed out waiting for OpenCode server to start after ${this.timeout}ms`,
          ),
        );
      }, this.timeout);

      let output = "";
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const reader = proc.stdout.getReader();
      const readChunks = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            output += new TextDecoder().decode(value);
            const lines = output.split("\n");
            for (const line of lines) {
              if (line.startsWith("opencode server listening")) {
                const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
                if (match) {
                  settle(() => resolve(match[1]!));
                  return;
                }
              }
            }
          }
        } catch {
          // Stream closed
        }
      };

      readChunks();

      proc.exited.then((code) => {
        settle(() =>
          reject(
            new OrchestrationError(
              "OPENCODE_SERVER_EXIT",
              `OpenCode server exited with code ${code} before becoming ready. Output: ${output}`,
            ),
          ),
        );
      });
    });
  }

  private async readServerInfo(workspacePath: string): Promise<ServerInfo | null> {
    const infoPath = serverInfoPath(workspacePath);
    try {
      const file = Bun.file(infoPath);
      if (!(await file.exists())) {
        return null;
      }
      return (await file.json()) as ServerInfo;
    } catch {
      return null;
    }
  }

  private async persistServerInfo(workspacePath: string, info: ServerInfo): Promise<void> {
    const infoPath = serverInfoPath(workspacePath);
    await mkdir(path.dirname(infoPath), { recursive: true });
    await Bun.write(infoPath, JSON.stringify(info, null, 2) + "\n");
  }

  private async removeServerInfo(workspacePath: string): Promise<void> {
    const infoPath = serverInfoPath(workspacePath);
    try {
      await Bun.file(infoPath).delete();
    } catch {
      // File may already be gone
    }
  }
}
