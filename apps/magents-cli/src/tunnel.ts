import type { Subprocess } from "bun";
import type { TunnelState } from "@magents/protocol";
import type { TunnelConfig, TunnelInfo, TunnelManager } from "./types";

const URL_TIMEOUT_MS = 30_000;
const GRACEFUL_SHUTDOWN_MS = 5_000;
const CLOUDFLARED_URL_REGEX = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

interface TunnelEntry {
  process: Subprocess;
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
    const proc = Bun.spawn(
      ["cloudflared", "tunnel", "--url", `http://localhost:${metroPort}`],
      { stdout: "ignore", stderr: "pipe" },
    );

    const publicUrl = await parseUrlFromStderr(proc, URL_TIMEOUT_MS);

    this.tunnels.set(sessionId, { process: proc, publicUrl, metroPort, config });
    this.watchForCrash(sessionId, proc);

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
    const proc = Bun.spawn(
      ["cloudflared", "tunnel", "--url", `http://localhost:${metroPort}`, "run", config.tunnelName],
      { stdout: "ignore", stderr: "pipe" },
    );

    const publicUrl = `https://${config.domain}`;
    this.tunnels.set(sessionId, { process: proc, publicUrl, metroPort, config });
    this.watchForCrash(sessionId, proc);

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

  private watchForCrash(sessionId: string, proc: Subprocess): void {
    proc.exited.then(() => {
      const entry = this.tunnels.get(sessionId);
      if (entry?.process === proc) {
        this.tunnels.delete(sessionId);
      }
    });
  }
}

function assertCloudflaredInstalled(): void {
  const result = Bun.spawnSync(["cloudflared", "--version"], {
    stdout: "ignore",
    stderr: "ignore",
  });

  if (!result.success) {
    throw new Error(
      "cloudflared is not installed or not found in PATH. " +
        "Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
    );
  }
}

async function parseUrlFromStderr(proc: Subprocess, timeoutMs: number): Promise<string> {
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const timeout = setTimeout(() => {
    reader.cancel();
  }, timeoutMs);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const match = buffer.match(CLOUDFLARED_URL_REGEX);
      if (match) {
        clearTimeout(timeout);
        reader.cancel();
        return match[0];
      }
    }
    throw new Error(
      "cloudflared exited unexpectedly before providing a URL.",
    );
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.message.includes("before providing a URL")) {
      throw err;
    }
    if (buffer.match(CLOUDFLARED_URL_REGEX)) {
      return buffer.match(CLOUDFLARED_URL_REGEX)![0];
    }
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for cloudflared to provide a public URL.`,
    );
  }
}

async function killProcess(proc: Subprocess): Promise<void> {
  if (proc.exitCode !== null) {
    return;
  }

  proc.kill("SIGTERM");

  const forceTimer = setTimeout(() => {
    proc.kill("SIGKILL");
  }, GRACEFUL_SHUTDOWN_MS);

  await proc.exited;
  clearTimeout(forceTimer);
}
