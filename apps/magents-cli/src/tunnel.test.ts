import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";

// Helper: create a fake Bun.Subprocess with controllable stderr stream and exited promise
function createFakeProcess(): {
  proc: Subprocess;
  writeStderr: (data: string) => void;
  resolveExited: (code: number) => void;
} {
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const stderrStream = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
    },
  });

  let resolveExited!: (code: number) => void;
  const exitedPromise = new Promise<number>((resolve) => {
    resolveExited = (code: number) => {
      resolve(code);
      (proc as any).exitCode = code;
      try { stderrController.close(); } catch { /* already closed */ }
    };
  });

  const proc = {
    pid: 12345,
    exitCode: null,
    killed: false,
    stdin: null,
    stdout: null,
    stderr: stderrStream,
    exited: exitedPromise,
    kill: mock((signal?: string) => {
      (proc as any).killed = true;
      // Simulate async exit after kill
      queueMicrotask(() => {
        resolveExited(signal === "SIGKILL" ? 137 : 0);
      });
    }),
    ref: () => {},
    unref: () => {},
    [Symbol.asyncDispose]: async () => {},
  } as unknown as Subprocess;

  return {
    proc,
    writeStderr: (data: string) => {
      stderrController.enqueue(new TextEncoder().encode(data));
    },
    resolveExited,
  };
}

// Helper to create a successful spawnSync result
function okSpawnSyncResult(): any {
  return {
    success: true,
    exitCode: 0,
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
  };
}

function failSpawnSyncResult(): any {
  return {
    success: false,
    exitCode: 1,
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
  };
}

// We need to mock both Bun.spawn and Bun.spawnSync
const originalSpawn = Bun.spawn;
const originalSpawnSync = Bun.spawnSync;

let mockSpawn: ReturnType<typeof mock>;
let mockSpawnSync: ReturnType<typeof mock>;

// Import after setting up — tunnel.ts uses Bun globals directly
const { CloudflareTunnelManager } = await import("./tunnel");

describe("CloudflareTunnelManager", () => {
  let manager: InstanceType<typeof CloudflareTunnelManager>;

  beforeEach(() => {
    manager = new CloudflareTunnelManager();
    mockSpawnSync = mock(() => okSpawnSyncResult());
    mockSpawn = mock();
    Bun.spawnSync = mockSpawnSync as any;
    Bun.spawn = mockSpawn as any;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
    Bun.spawnSync = originalSpawnSync;
  });

  describe("attach — quick tunnel mode", () => {
    it("spawns cloudflared with correct args and parses URL from stderr", async () => {
      const { proc, writeStderr } = createFakeProcess();
      mockSpawn.mockReturnValue(proc);

      const attachPromise = manager.attach({
        sessionId: "sess-1",
        metroPort: 8081,
      });

      // Simulate cloudflared printing the URL to stderr
      queueMicrotask(() => {
        writeStderr(
          "2024-01-01T00:00:00Z INF |  https://random-words.trycloudflare.com\n",
        );
      });

      const result = await attachPromise;

      expect(result).toEqual({
        connected: true,
        provider: "cloudflare",
        publicUrl: "https://random-words.trycloudflare.com",
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        ["cloudflared", "tunnel", "--url", "http://localhost:8081"],
        expect.objectContaining({ stdout: "ignore", stderr: "pipe" }),
      );
    });

    it("returns existing tunnel if already attached", async () => {
      const { proc, writeStderr } = createFakeProcess();
      mockSpawn.mockReturnValue(proc);

      const attachPromise = manager.attach({
        sessionId: "sess-reuse",
        metroPort: 8082,
      });

      queueMicrotask(() => {
        writeStderr("INF |  https://my-tunnel.trycloudflare.com\n");
      });

      await attachPromise;

      // Second attach should reuse the existing tunnel without spawning
      mockSpawn.mockReset();
      const result = await manager.attach({
        sessionId: "sess-reuse",
        metroPort: 8082,
      });

      expect(result.connected).toBe(true);
      expect(result.publicUrl).toBe("https://my-tunnel.trycloudflare.com");
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("returns publicUrl directly when provided", async () => {
      const result = await manager.attach({
        sessionId: "sess-manual",
        metroPort: 8081,
        publicUrl: "https://my-custom-url.example.com",
      });

      expect(result).toEqual({
        connected: true,
        provider: "cloudflare",
        publicUrl: "https://my-custom-url.example.com",
      });
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("rejects if cloudflared exits before printing URL", async () => {
      const { proc, resolveExited } = createFakeProcess();
      mockSpawn.mockReturnValue(proc);

      const attachPromise = manager.attach({
        sessionId: "sess-crash",
        metroPort: 8081,
      });

      queueMicrotask(() => {
        resolveExited(1);
      });

      await expect(attachPromise).rejects.toThrow("exited unexpectedly");
    });
  });

  describe("attach — named tunnel mode", () => {
    it("spawns cloudflared with tunnel run and uses configured domain", async () => {
      const { proc } = createFakeProcess();
      mockSpawn.mockReturnValue(proc);

      const result = await manager.attach({
        sessionId: "sess-named",
        metroPort: 8083,
        tunnelConfig: {
          mode: "named",
          tunnelName: "my-tunnel",
          domain: "app.example.com",
        },
      });

      expect(result).toEqual({
        connected: true,
        provider: "cloudflare",
        publicUrl: "https://app.example.com",
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        ["cloudflared", "tunnel", "--url", "http://localhost:8083", "run", "my-tunnel"],
        expect.objectContaining({ stdout: "ignore", stderr: "pipe" }),
      );
    });
  });

  describe("detach", () => {
    it("kills the process and removes from map", async () => {
      const { proc, writeStderr } = createFakeProcess();
      mockSpawn.mockReturnValue(proc);

      const attachPromise = manager.attach({
        sessionId: "sess-detach",
        metroPort: 8084,
      });

      queueMicrotask(() => {
        writeStderr("INF |  https://detach-test.trycloudflare.com\n");
      });

      await attachPromise;

      const result = await manager.detach({ sessionId: "sess-detach" });

      expect(result).toEqual({ connected: false, provider: "none" });
      expect((proc as any).kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("returns disconnected state when session not found", async () => {
      const result = await manager.detach({ sessionId: "nonexistent" });
      expect(result).toEqual({ connected: false, provider: "none" });
    });
  });

  describe("multiple simultaneous tunnels", () => {
    it("manages two tunnels independently", async () => {
      const fake1 = createFakeProcess();
      const fake2 = createFakeProcess();
      mockSpawn.mockReturnValueOnce(fake1.proc).mockReturnValueOnce(fake2.proc);

      const p1 = manager.attach({ sessionId: "sess-a", metroPort: 8081 });
      queueMicrotask(() => {
        fake1.writeStderr("INF |  https://tunnel-a.trycloudflare.com\n");
      });
      const r1 = await p1;

      const p2 = manager.attach({ sessionId: "sess-b", metroPort: 8082 });
      queueMicrotask(() => {
        fake2.writeStderr("INF |  https://tunnel-b.trycloudflare.com\n");
      });
      const r2 = await p2;

      expect(r1.publicUrl).toBe("https://tunnel-a.trycloudflare.com");
      expect(r2.publicUrl).toBe("https://tunnel-b.trycloudflare.com");

      // Detach one, other should remain
      await manager.detach({ sessionId: "sess-a" });

      const stillActive = await manager.attach({ sessionId: "sess-b", metroPort: 8082 });
      expect(stillActive.publicUrl).toBe("https://tunnel-b.trycloudflare.com");
      expect(mockSpawn).toHaveBeenCalledTimes(2); // No new spawn for sess-b reuse
    });
  });

  describe("crash detection", () => {
    it("removes tunnel from map when process crashes", async () => {
      const { proc, writeStderr, resolveExited } = createFakeProcess();
      mockSpawn.mockReturnValue(proc);

      const attachPromise = manager.attach({
        sessionId: "sess-crash-detect",
        metroPort: 8085,
      });

      queueMicrotask(() => {
        writeStderr("INF |  https://crash-detect.trycloudflare.com\n");
      });

      await attachPromise;

      // Simulate crash after URL was parsed
      resolveExited(1);

      // Give the exited handler a tick to run
      await new Promise((r) => setTimeout(r, 10));

      // Now attach again should spawn a new process
      const fake2 = createFakeProcess();
      mockSpawn.mockReturnValue(fake2.proc);

      const reattach = manager.attach({ sessionId: "sess-crash-detect", metroPort: 8085 });
      queueMicrotask(() => {
        fake2.writeStderr("INF |  https://new-tunnel.trycloudflare.com\n");
      });

      const result = await reattach;
      expect(result.publicUrl).toBe("https://new-tunnel.trycloudflare.com");
    });
  });

  describe("cloudflared not installed", () => {
    it("throws a clear error when cloudflared is not found", async () => {
      mockSpawnSync.mockReturnValue(failSpawnSyncResult());

      await expect(
        manager.attach({ sessionId: "sess-nobin", metroPort: 8081 }),
      ).rejects.toThrow("cloudflared is not installed or not found in PATH");
    });
  });
});
