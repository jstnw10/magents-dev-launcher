import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// We need to mock child_process before importing the module under test.
// Bun's module mocking works by replacing the module in the registry.

let mockSpawn: ReturnType<typeof mock>;
let mockExecSync: ReturnType<typeof mock>;

// Fake ChildProcess that emits events and has a controllable stderr stream
function createFakeProcess(): ChildProcess & {
  _stderr: EventEmitter;
  _emit: (event: string, ...args: unknown[]) => void;
  _writeStderr: (data: string) => void;
} {
  const proc = new EventEmitter() as ChildProcess & {
    _stderr: EventEmitter;
    _emit: (event: string, ...args: unknown[]) => void;
    _writeStderr: (data: string) => void;
  };

  proc._stderr = new EventEmitter();
  (proc as any).stderr = proc._stderr;
  (proc as any).stdout = null;
  (proc as any).stdin = null;
  (proc as any).pid = 12345;
  (proc as any).exitCode = null;
  (proc as any).killed = false;
  (proc as any).kill = mock((signal?: string) => {
    if (signal === "SIGKILL" || signal === "SIGTERM" || !signal) {
      (proc as any).killed = true;
      // Simulate async exit after kill
      queueMicrotask(() => {
        (proc as any).exitCode = signal === "SIGKILL" ? 137 : 0;
        proc.emit("exit", (proc as any).exitCode, signal ?? "SIGTERM");
      });
    }
    return true;
  });

  proc._emit = (event: string, ...args: unknown[]) => proc.emit(event, ...args);
  proc._writeStderr = (data: string) => proc._stderr.emit("data", Buffer.from(data));

  return proc;
}

// Since Bun doesn't support module mocking easily, we'll test by importing
// the module and using a different approach: we'll test the class behavior
// by creating a wrapper that allows injecting dependencies.

// Alternative approach: re-export the module pieces and test the logic directly.
// For testability, we'll create a version of CloudflareTunnelManager that accepts
// a spawn function and an install-check function.

// Let's create a test-friendly version by importing and monkey-patching.

// Actually, the cleanest approach for Bun is to use mock.module:
mock.module("node:child_process", () => {
  mockSpawn = mock();
  mockExecSync = mock();
  return {
    spawn: mockSpawn,
    execSync: mockExecSync,
  };
});

// Import AFTER mocking
const { CloudflareTunnelManager } = await import("./tunnel");

describe("CloudflareTunnelManager", () => {
  let manager: InstanceType<typeof CloudflareTunnelManager>;

  beforeEach(() => {
    manager = new CloudflareTunnelManager();
    mockExecSync.mockImplementation(() => Buffer.from("cloudflared version 2024.1.0"));
    mockSpawn.mockReset();
  });

  describe("attach — quick tunnel mode", () => {
    it("spawns cloudflared with correct args and parses URL from stderr", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const attachPromise = manager.attach({
        sessionId: "sess-1",
        metroPort: 8081,
      });

      // Simulate cloudflared printing the URL to stderr
      queueMicrotask(() => {
        fakeProc._writeStderr(
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
        "cloudflared",
        ["tunnel", "--url", "http://localhost:8081"],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    });

    it("returns existing tunnel if already attached", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const attachPromise = manager.attach({
        sessionId: "sess-reuse",
        metroPort: 8082,
      });

      queueMicrotask(() => {
        fakeProc._writeStderr(
          "INF |  https://my-tunnel.trycloudflare.com\n",
        );
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
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const attachPromise = manager.attach({
        sessionId: "sess-crash",
        metroPort: 8081,
      });

      queueMicrotask(() => {
        (fakeProc as any).exitCode = 1;
        fakeProc.emit("exit", 1, null);
      });

      await expect(attachPromise).rejects.toThrow("cloudflared exited unexpectedly");
    });

    it("rejects if cloudflared emits an error", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const attachPromise = manager.attach({
        sessionId: "sess-err",
        metroPort: 8081,
      });

      queueMicrotask(() => {
        fakeProc.emit("error", new Error("ENOENT"));
      });

      await expect(attachPromise).rejects.toThrow("cloudflared process error: ENOENT");
    });
  });

  describe("attach — named tunnel mode", () => {
    it("spawns cloudflared with tunnel run and uses configured domain", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

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
        "cloudflared",
        ["tunnel", "--url", "http://localhost:8083", "run", "my-tunnel"],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    });
  });

  describe("detach", () => {
    it("kills the process and removes from map", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const attachPromise = manager.attach({
        sessionId: "sess-detach",
        metroPort: 8084,
      });

      queueMicrotask(() => {
        fakeProc._writeStderr("INF |  https://detach-test.trycloudflare.com\n");
      });

      await attachPromise;

      const result = await manager.detach({ sessionId: "sess-detach" });

      expect(result).toEqual({ connected: false, provider: "none" });
      expect((fakeProc as any).kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("returns disconnected state when session not found", async () => {
      const result = await manager.detach({ sessionId: "nonexistent" });
      expect(result).toEqual({ connected: false, provider: "none" });
    });
  });

  describe("multiple simultaneous tunnels", () => {
    it("manages two tunnels independently", async () => {
      const proc1 = createFakeProcess();
      const proc2 = createFakeProcess();
      mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

      const p1 = manager.attach({ sessionId: "sess-a", metroPort: 8081 });
      queueMicrotask(() => {
        proc1._writeStderr("INF |  https://tunnel-a.trycloudflare.com\n");
      });
      const r1 = await p1;

      const p2 = manager.attach({ sessionId: "sess-b", metroPort: 8082 });
      queueMicrotask(() => {
        proc2._writeStderr("INF |  https://tunnel-b.trycloudflare.com\n");
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
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const attachPromise = manager.attach({
        sessionId: "sess-crash-detect",
        metroPort: 8085,
      });

      queueMicrotask(() => {
        fakeProc._writeStderr("INF |  https://crash-detect.trycloudflare.com\n");
      });

      await attachPromise;

      // Simulate crash after URL was parsed
      (fakeProc as any).exitCode = 1;
      fakeProc.emit("exit", 1, null);

      // Give the event handler a tick to run
      await new Promise((r) => setTimeout(r, 10));

      // Now attach again should spawn a new process
      const proc2 = createFakeProcess();
      mockSpawn.mockReturnValue(proc2);

      const reattach = manager.attach({ sessionId: "sess-crash-detect", metroPort: 8085 });
      queueMicrotask(() => {
        proc2._writeStderr("INF |  https://new-tunnel.trycloudflare.com\n");
      });

      const result = await reattach;
      expect(result.publicUrl).toBe("https://new-tunnel.trycloudflare.com");
    });
  });

  describe("cloudflared not installed", () => {
    it("throws a clear error when cloudflared is not found", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("command not found");
      });

      await expect(
        manager.attach({ sessionId: "sess-nobin", metroPort: 8081 }),
      ).rejects.toThrow("cloudflared is not installed or not found in PATH");
    });
  });
});
