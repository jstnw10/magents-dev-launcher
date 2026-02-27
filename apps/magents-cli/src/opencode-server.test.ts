import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  OpenCodeServer,
  type ServerInfo,
  type SpawnedProcess,
  type SpawnOptions,
} from "./opencode-server";
import type { ResolvedOpencode } from "./opencode-resolver";
import { OrchestrationError } from "./types";

function mockResolveOpencode(): () => Promise<ResolvedOpencode> {
  return async () => ({
    path: "/usr/local/bin/opencode",
    version: "1.2.14",
    source: "auto-detected" as const,
  });
}

function mockAllocatePort(port = 4096): () => Promise<number> {
  return async () => port;
}

/**
 * Creates a mock spawn that immediately emits the ready line on stdout.
 */
function mockSpawnReady(
  pid = 12345,
  port = 4096,
): (cmd: string, args: string[], opts: SpawnOptions) => SpawnedProcess {
  return (_cmd, _args, _opts) => {
    const readyLine = `opencode server listening on http://127.0.0.1:${port}\n`;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(readyLine));
        controller.close();
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    return {
      pid,
      stdout,
      stderr,
      exited: new Promise(() => {}), // Never resolves — server stays running
      kill() {},
    };
  };
}

/**
 * Creates a mock spawn that exits immediately without emitting the ready line.
 */
function mockSpawnExit(
  exitCode = 1,
): (cmd: string, args: string[], opts: SpawnOptions) => SpawnedProcess {
  return (_cmd, _args, _opts) => {
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("some error output\n"));
        controller.close();
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    return {
      pid: 99999,
      stdout,
      stderr,
      exited: Promise.resolve(exitCode),
      kill() {},
    };
  };
}

/**
 * Creates a mock spawn that never emits the ready line (for timeout testing).
 */
function mockSpawnHang(): (cmd: string, args: string[], opts: SpawnOptions) => SpawnedProcess {
  let killed = false;
  return (_cmd, _args, _opts) => {
    const stdout = new ReadableStream<Uint8Array>({
      start() {
        // Never enqueue anything, never close
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    return {
      pid: 88888,
      stdout,
      stderr,
      exited: new Promise(() => {}),
      kill() {
        killed = true;
      },
    };
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "opencode-server-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("OpenCodeServer.start", () => {
  it("spawns the server and persists server.json", async () => {
    const spawnCalls: { cmd: string; args: string[]; env: Record<string, string | undefined> }[] = [];
    const spawnProcess = (cmd: string, args: string[], opts: SpawnOptions) => {
      spawnCalls.push({ cmd, args, env: opts.env });
      return mockSpawnReady(12345, 4096)(cmd, args, opts);
    };

    const server = new OpenCodeServer({
      resolveOpencode: mockResolveOpencode(),
      allocatePort: mockAllocatePort(4096),
      spawnProcess,
    });

    const info = await server.start(tmpDir);

    expect(info.pid).toBe(12345);
    expect(info.port).toBe(4096);
    expect(info.url).toBe("http://127.0.0.1:4096");
    expect(info.startedAt).toBeTruthy();

    // Verify spawn args
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.cmd).toBe("/usr/local/bin/opencode");
    expect(spawnCalls[0]!.args).toEqual(["serve", "--hostname=127.0.0.1", "--port=4096"]);
    expect(spawnCalls[0]!.env.OPENCODE_CONFIG_DIR).toBe(
      path.join(tmpDir, ".workspace", "opencode", "data"),
    );

    // Verify server.json was written
    const serverJson = await Bun.file(
      path.join(tmpDir, ".workspace", "opencode", "server.json"),
    ).json();
    expect(serverJson.pid).toBe(12345);
    expect(serverJson.port).toBe(4096);
    expect(serverJson.url).toBe("http://127.0.0.1:4096");
  });

  it("creates the opencode data directory", async () => {
    const server = new OpenCodeServer({
      resolveOpencode: mockResolveOpencode(),
      allocatePort: mockAllocatePort(),
      spawnProcess: mockSpawnReady(),
    });

    await server.start(tmpDir);

    const dataDir = path.join(tmpDir, ".workspace", "opencode", "data");
    const entries = await readdir(dataDir);
    expect(entries).toBeDefined();
  });

  it("throws OPENCODE_SERVER_EXIT if process exits before ready", async () => {
    const server = new OpenCodeServer({
      resolveOpencode: mockResolveOpencode(),
      allocatePort: mockAllocatePort(),
      spawnProcess: mockSpawnExit(1),
    });

    try {
      await server.start(tmpDir);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
      expect((err as OrchestrationError).code).toBe("OPENCODE_SERVER_EXIT");
    }
  });

  it("throws OPENCODE_SERVER_TIMEOUT if server never becomes ready", async () => {
    const server = new OpenCodeServer({
      resolveOpencode: mockResolveOpencode(),
      allocatePort: mockAllocatePort(),
      timeout: 100, // Very short timeout
      spawnProcess: mockSpawnHang(),
    });

    try {
      await server.start(tmpDir);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
      expect((err as OrchestrationError).code).toBe("OPENCODE_SERVER_TIMEOUT");
    }
  });

  it("throws when binary resolution fails", async () => {
    const server = new OpenCodeServer({
      resolveOpencode: async () => {
        throw new OrchestrationError("OPENCODE_NOT_FOUND", "not found");
      },
      allocatePort: mockAllocatePort(),
      spawnProcess: mockSpawnReady(),
    });

    await expect(server.start(tmpDir)).rejects.toThrow(OrchestrationError);
  });
});

describe("OpenCodeServer.stop", () => {
  it("removes server.json when stopping", async () => {
    const server = new OpenCodeServer({
      resolveOpencode: mockResolveOpencode(),
      allocatePort: mockAllocatePort(),
      spawnProcess: mockSpawnReady(),
    });

    await server.start(tmpDir);

    // Verify server.json exists
    const infoPath = path.join(tmpDir, ".workspace", "opencode", "server.json");
    expect(await Bun.file(infoPath).exists()).toBe(true);

    await server.stop(tmpDir);

    // server.json should be gone
    expect(await Bun.file(infoPath).exists()).toBe(false);
  });

  it("is a no-op if no server.json exists", async () => {
    const server = new OpenCodeServer({
      resolveOpencode: mockResolveOpencode(),
      allocatePort: mockAllocatePort(),
      spawnProcess: mockSpawnReady(),
    });

    // Should not throw
    await server.stop(tmpDir);
  });
});

describe("OpenCodeServer.status", () => {
  it("returns running: false when no server.json exists", async () => {
    const server = new OpenCodeServer({
      resolveOpencode: mockResolveOpencode(),
      allocatePort: mockAllocatePort(),
      spawnProcess: mockSpawnReady(),
    });

    const result = await server.status(tmpDir);
    expect(result.running).toBe(false);
    expect(result.info).toBeUndefined();
  });

  it("detects stale PID and cleans up server.json", async () => {
    // Write a server.json with a PID that doesn't exist
    const infoDir = path.join(tmpDir, ".workspace", "opencode");
    const { mkdir: mkdirFs } = await import("node:fs/promises");
    await mkdirFs(infoDir, { recursive: true });
    const staleInfo: ServerInfo = {
      pid: 999999999, // Almost certainly not a running PID
      port: 4096,
      url: "http://127.0.0.1:4096",
      startedAt: new Date().toISOString(),
    };
    await Bun.write(
      path.join(infoDir, "server.json"),
      JSON.stringify(staleInfo, null, 2) + "\n",
    );

    const server = new OpenCodeServer({
      resolveOpencode: mockResolveOpencode(),
      allocatePort: mockAllocatePort(),
      spawnProcess: mockSpawnReady(),
    });

    const result = await server.status(tmpDir);
    expect(result.running).toBe(false);

    // Should have cleaned up the stale server.json
    expect(
      await Bun.file(path.join(infoDir, "server.json")).exists(),
    ).toBe(false);
  });

  it("returns running: true when PID is alive", async () => {
    // Use current process PID which is definitely alive
    const infoDir = path.join(tmpDir, ".workspace", "opencode");
    const { mkdir: mkdirFs } = await import("node:fs/promises");
    await mkdirFs(infoDir, { recursive: true });
    const liveInfo: ServerInfo = {
      pid: process.pid, // Current process is definitely alive
      port: 4096,
      url: "http://127.0.0.1:4096",
      startedAt: new Date().toISOString(),
    };
    await Bun.write(
      path.join(infoDir, "server.json"),
      JSON.stringify(liveInfo, null, 2) + "\n",
    );

    const server = new OpenCodeServer({
      resolveOpencode: mockResolveOpencode(),
      allocatePort: mockAllocatePort(),
      spawnProcess: mockSpawnReady(),
    });

    const result = await server.status(tmpDir);
    expect(result.running).toBe(true);
    expect(result.info?.pid).toBe(process.pid);
  });
});

describe("OpenCodeServer.getOrStart", () => {
  it("starts a new server if none is running", async () => {
    let spawnCalled = false;
    const spawnProcess = (cmd: string, args: string[], opts: SpawnOptions) => {
      spawnCalled = true;
      return mockSpawnReady()(cmd, args, opts);
    };

    const server = new OpenCodeServer({
      resolveOpencode: mockResolveOpencode(),
      allocatePort: mockAllocatePort(),
      spawnProcess,
    });

    const info = await server.getOrStart(tmpDir);
    expect(spawnCalled).toBe(true);
    expect(info.pid).toBe(12345);
  });

  it("reuses existing server if PID is alive", async () => {
    // Write a server.json with current process PID
    const infoDir = path.join(tmpDir, ".workspace", "opencode");
    const { mkdir: mkdirFs } = await import("node:fs/promises");
    await mkdirFs(infoDir, { recursive: true });
    const existingInfo: ServerInfo = {
      pid: process.pid,
      port: 5555,
      url: "http://127.0.0.1:5555",
      startedAt: "2024-01-01T00:00:00.000Z",
    };
    await Bun.write(
      path.join(infoDir, "server.json"),
      JSON.stringify(existingInfo, null, 2) + "\n",
    );

    let spawnCalled = false;
    const spawnProcess = (cmd: string, args: string[], opts: SpawnOptions) => {
      spawnCalled = true;
      return mockSpawnReady()(cmd, args, opts);
    };

    const server = new OpenCodeServer({
      resolveOpencode: mockResolveOpencode(),
      allocatePort: mockAllocatePort(),
      spawnProcess,
    });

    const info = await server.getOrStart(tmpDir);
    expect(spawnCalled).toBe(false);
    expect(info.port).toBe(5555);
    expect(info.url).toBe("http://127.0.0.1:5555");
  });

  it("starts a new server if existing PID is stale", async () => {
    // Write a server.json with a stale PID
    const infoDir = path.join(tmpDir, ".workspace", "opencode");
    const { mkdir: mkdirFs } = await import("node:fs/promises");
    await mkdirFs(infoDir, { recursive: true });
    const staleInfo: ServerInfo = {
      pid: 999999999,
      port: 5555,
      url: "http://127.0.0.1:5555",
      startedAt: "2024-01-01T00:00:00.000Z",
    };
    await Bun.write(
      path.join(infoDir, "server.json"),
      JSON.stringify(staleInfo, null, 2) + "\n",
    );

    let spawnCalled = false;
    const spawnProcess = (cmd: string, args: string[], opts: SpawnOptions) => {
      spawnCalled = true;
      return mockSpawnReady()(cmd, args, opts);
    };

    const server = new OpenCodeServer({
      resolveOpencode: mockResolveOpencode(),
      allocatePort: mockAllocatePort(),
      spawnProcess,
    });

    const info = await server.getOrStart(tmpDir);
    expect(spawnCalled).toBe(true);
    expect(info.pid).toBe(12345);
  });
});
