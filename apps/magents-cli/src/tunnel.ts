import { spawn, execSync, type ChildProcess } from "node:child_process";
import type { TunnelState } from "@magents/protocol";
import type { TunnelConfig, TunnelInfo, TunnelManager } from "./types";

const URL_TIMEOUT_MS = 30_000;
const GRACEFUL_SHUTDOWN_MS = 5_000;
const CLOUDFLARED_URL_REGEX = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

interface TunnelEntry {
  process: ChildProcess;
  publicUrl: string;
  metroPort: number;
  config: TunnelConfig;
}

export class CloudflareTunnelManager implements TunnelManager {
  private readonly tunnels = new Map<string, TunnelEntry>();

  async attach(input: {
    sessionId: string;
    metroPort: number;
    publicUrl?: string;
    tunnelConfig?: TunnelConfig;
  }): Promise<TunnelState> {
    if (input.publicUrl) {
      return {
        connected: true,
        provider: "cloudflare",
        publicUrl: input.publicUrl,
      };
    }

    const existing = this.tunnels.get(input.sessionId);
    if (existing) {
      return {
        connected: true,
        provider: "cloudflare",
        publicUrl: existing.publicUrl,
      };
    }

    assertCloudflaredInstalled();

    const config: TunnelConfig = input.tunnelConfig ?? { mode: "quick" };

    if (config.mode === "named") {
      return this.startNamedTunnel(input.sessionId, input.metroPort, config);
    }

    return this.startQuickTunnel(input.sessionId, input.metroPort, config);
  }

  async detach(input: { sessionId: string }): Promise<TunnelState> {
    const entry = this.tunnels.get(input.sessionId);
    if (!entry) {
      return { connected: false, provider: "none" };
    }

    await killProcess(entry.process);
    this.tunnels.delete(input.sessionId);

    return { connected: false, provider: "none" };
  }

  private async startQuickTunnel(
    sessionId: string,
    metroPort: number,
    config: TunnelConfig,
  ): Promise<TunnelState> {
    const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${metroPort}`], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    const publicUrl = await parseUrlFromStderr(child, URL_TIMEOUT_MS);

    this.tunnels.set(sessionId, { process: child, publicUrl, metroPort, config });
    this.watchForCrash(sessionId, child);

    return {
      connected: true,
      provider: "cloudflare",
      publicUrl,
    };
  }

  private async startNamedTunnel(
    sessionId: string,
    metroPort: number,
    config: Extract<TunnelConfig, { mode: "named" }>,
  ): Promise<TunnelState> {
    const child = spawn(
      "cloudflared",
      ["tunnel", "--url", `http://localhost:${metroPort}`, "run", config.tunnelName],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    const publicUrl = `https://${config.domain}`;
    this.tunnels.set(sessionId, { process: child, publicUrl, metroPort, config });
    this.watchForCrash(sessionId, child);

    return {
      connected: true,
      provider: "cloudflare",
      publicUrl,
    };
  }

  list(): TunnelInfo[] {
    return Array.from(this.tunnels.entries()).map(([sessionId, entry]) => ({
      sessionId,
      publicUrl: entry.publicUrl,
      metroPort: entry.metroPort,
      config: entry.config,
    }));
  }

  getStatus(sessionId: string): TunnelInfo | undefined {
    const entry = this.tunnels.get(sessionId);
    if (!entry) return undefined;
    return {
      sessionId,
      publicUrl: entry.publicUrl,
      metroPort: entry.metroPort,
      config: entry.config,
    };
  }

  private watchForCrash(sessionId: string, child: ChildProcess): void {
    child.on("exit", (code, signal) => {
      const entry = this.tunnels.get(sessionId);
      if (entry?.process === child) {
        this.tunnels.delete(sessionId);
      }
    });
  }
}

function assertCloudflaredInstalled(): void {
  try {
    execSync("cloudflared --version", { stdio: "ignore" });
  } catch {
    throw new Error(
      "cloudflared is not installed or not found in PATH. " +
        "Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
    );
  }
}

function parseUrlFromStderr(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for cloudflared to provide a public URL.`,
          ),
        );
      }
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(CLOUDFLARED_URL_REGEX);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        child.stderr?.removeListener("data", onData);
        resolve(match[0]);
      }
    };

    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared process error: ${err.message}`));
      }
    });

    child.on("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `cloudflared exited unexpectedly (code=${code}, signal=${signal}) before providing a URL.`,
          ),
        );
      }
    });
  });
}

function killProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }

    const forceTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, GRACEFUL_SHUTDOWN_MS);

    child.on("exit", () => {
      clearTimeout(forceTimer);
      resolve();
    });

    child.kill("SIGTERM");
  });
}
