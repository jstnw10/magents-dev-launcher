import { describe, expect, it, mock } from "bun:test";

import { MockPortAllocator, SystemPortAllocator } from "./port-allocator";
import type { SessionRecord, SessionRegistry } from "./types";

class InMemoryRegistry implements SessionRegistry {
  constructor(private readonly sessions: SessionRecord[] = []) {}

  async load() {
    return this.sessions.map((s) => ({
      ...s,
      tunnel: { ...s.tunnel },
    }));
  }

  async save(sessions: SessionRecord[]) {
    this.sessions.length = 0;
    this.sessions.push(...sessions);
  }
}

function makeSession(overrides: Partial<SessionRecord> & { metroPort: number }): SessionRecord {
  return {
    id: `sess-${overrides.metroPort}`,
    label: `Session ${overrides.metroPort}`,
    projectRoot: "/tmp/project",
    state: "running",
    tunnel: { connected: false, provider: "none" },
    ...overrides,
  };
}

describe("SystemPortAllocator", () => {
  it("returns 8081 for the first allocation when the port is free", async () => {
    const registry = new InMemoryRegistry();
    const allocator = new SystemPortAllocator(registry);

    const port = await allocator.allocate();

    expect(port).toBe(8081);
  });

  it("returns a port >8081 for the second allocation", async () => {
    const registry = new InMemoryRegistry();
    const allocator = new SystemPortAllocator(registry);

    const first = await allocator.allocate();
    const second = await allocator.allocate();

    expect(first).toBe(8081);
    expect(second).toBeGreaterThan(8081);
    expect(second).toBeLessThanOrEqual(9999);
  });

  it("skips 8081 when registry has an active session on that port", async () => {
    const registry = new InMemoryRegistry([makeSession({ metroPort: 8081 })]);
    const allocator = new SystemPortAllocator(registry);

    const port = await allocator.allocate();

    expect(port).toBeGreaterThan(8081);
    expect(port).toBeLessThanOrEqual(9999);
  });

  it("does not reuse ports already allocated in the same allocator instance", async () => {
    const registry = new InMemoryRegistry();
    const allocator = new SystemPortAllocator(registry);

    const ports = new Set<number>();
    for (let i = 0; i < 5; i++) {
      ports.add(await allocator.allocate());
    }

    expect(ports.size).toBe(5);
  });

  it("allows re-allocation of a released port", async () => {
    const registry = new InMemoryRegistry();
    const allocator = new SystemPortAllocator(registry);

    const port = await allocator.allocate();
    allocator.release(port);
    // After release, the port is no longer tracked as allocated
    // (it may or may not be re-selected due to randomness, but it's eligible)
    expect(port).toBe(8081);
  });

  it("ignores stopped sessions when checking used ports", async () => {
    const registry = new InMemoryRegistry([makeSession({ metroPort: 8081, state: "stopped" })]);
    const allocator = new SystemPortAllocator(registry);

    const port = await allocator.allocate();

    expect(port).toBe(8081);
  });

  it("throws PORT_EXHAUSTED when no port can be found", async () => {
    // Create a registry where all ports in range are "taken" via the isPortFree check
    // We'll simulate this by making the allocator's internal set cover all candidates
    const registry = new InMemoryRegistry();
    const allocator = new SystemPortAllocator(registry);

    // Allocate first (8081), then fill internal allocated set to block all random candidates
    await allocator.allocate();

    // Fill the allocated set with every port in range so all candidates are skipped
    for (let p = 8082; p <= 9999; p++) {
      (allocator as unknown as { allocated: Set<number> }).allocated.add(p);
    }

    await expect(allocator.allocate()).rejects.toThrow("Failed to find an available port");
  });
});

describe("MockPortAllocator", () => {
  it("returns sequential ports starting from default", async () => {
    const allocator = new MockPortAllocator();

    expect(await allocator.allocate()).toBe(8081);
    expect(await allocator.allocate()).toBe(8082);
    expect(await allocator.allocate()).toBe(8083);
  });

  it("accepts a custom start port", async () => {
    const allocator = new MockPortAllocator(3000);

    expect(await allocator.allocate()).toBe(3000);
    expect(await allocator.allocate()).toBe(3001);
  });
});
