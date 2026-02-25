import { DEFAULT_METRO_PORT, OrchestrationError, type PortAllocator, type SessionRegistry } from "./types";

const PORT_RANGE_MIN = 8082;
const PORT_RANGE_MAX = 9999;
const MAX_RETRIES = 10;

async function isPortFree(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch() { return new Response(); },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

function randomPortInRange(): number {
  return PORT_RANGE_MIN + Math.floor(Math.random() * (PORT_RANGE_MAX - PORT_RANGE_MIN + 1));
}

export class SystemPortAllocator implements PortAllocator {
  private allocated = new Set<number>();
  private isFirstAllocation = true;

  constructor(private readonly registry: SessionRegistry) {}

  async allocate(): Promise<number> {
    const sessions = await this.registry.load();
    const usedPorts = new Set(
      sessions.filter((s) => s.state !== "stopped").map((s) => s.metroPort)
    );

    for (const port of this.allocated) {
      usedPorts.add(port);
    }

    if (this.isFirstAllocation) {
      this.isFirstAllocation = false;

      if (!usedPorts.has(DEFAULT_METRO_PORT) && (await isPortFree(DEFAULT_METRO_PORT))) {
        this.allocated.add(DEFAULT_METRO_PORT);
        return DEFAULT_METRO_PORT;
      }
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const candidate = randomPortInRange();

      if (usedPorts.has(candidate)) {
        continue;
      }

      if (await isPortFree(candidate)) {
        this.allocated.add(candidate);
        return candidate;
      }
    }

    throw new OrchestrationError(
      "PORT_EXHAUSTED",
      `Failed to find an available port after ${MAX_RETRIES} attempts.`
    );
  }

  release(port: number): void {
    this.allocated.delete(port);
  }
}

export class MockPortAllocator implements PortAllocator {
  private nextPort: number;

  constructor(startPort = DEFAULT_METRO_PORT) {
    this.nextPort = startPort;
  }

  async allocate(): Promise<number> {
    return this.nextPort++;
  }

  release(_port: number): void {
    // no-op for mock
  }
}
