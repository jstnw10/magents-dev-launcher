import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import {
  appendEvent,
  readEvents,
  queryEvents,
  getEventsFilePath,
  getAgentActivity,
  getRecentFiles,
  getDirectoryChanges,
  getWorkspaceSummary,
} from "./event-storage";

describe("event-storage", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realpath(
      await mkdtemp(join(tmpdir(), "magents-events-test-")),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("appendEvent", () => {
    it("creates JSONL file and appends event", async () => {
      const event = await appendEvent(tmpDir, {
        type: "file:changed",
        actor: { type: "user" },
        data: { path: "src/index.ts" },
      });

      expect(event.id).toBeDefined();
      expect(event.timestamp).toBeDefined();
      expect(event.type).toBe("file:changed");
      expect(event.actor.type).toBe("user");

      const file = Bun.file(getEventsFilePath(tmpDir));
      expect(await file.exists()).toBe(true);

      const text = await file.text();
      const parsed = JSON.parse(text.trim());
      expect(parsed.id).toBe(event.id);
    });

    it("appends to existing JSONL file", async () => {
      await appendEvent(tmpDir, {
        type: "file:changed",
        actor: { type: "user" },
        data: { path: "a.ts" },
      });
      await appendEvent(tmpDir, {
        type: "agent:idle",
        actor: { type: "agent", id: "agent-1" },
        data: {},
      });

      const text = await Bun.file(getEventsFilePath(tmpDir)).text();
      const lines = text.trim().split("\n");
      expect(lines).toHaveLength(2);

      expect(JSON.parse(lines[0]).type).toBe("file:changed");
      expect(JSON.parse(lines[1]).type).toBe("agent:idle");
    });
  });

  describe("readEvents", () => {
    it("reads events in order", async () => {
      await appendEvent(tmpDir, {
        type: "first",
        actor: { type: "system" },
        data: {},
      });
      await appendEvent(tmpDir, {
        type: "second",
        actor: { type: "system" },
        data: {},
      });

      const events = await readEvents(tmpDir);
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("first");
      expect(events[1].type).toBe("second");
    });

    it("handles empty/missing file", async () => {
      const events = await readEvents(tmpDir);
      expect(events).toEqual([]);
    });

    it("with limit returns last N", async () => {
      await appendEvent(tmpDir, {
        type: "a",
        actor: { type: "system" },
        data: {},
      });
      await appendEvent(tmpDir, {
        type: "b",
        actor: { type: "system" },
        data: {},
      });
      await appendEvent(tmpDir, {
        type: "c",
        actor: { type: "system" },
        data: {},
      });

      const events = await readEvents(tmpDir, 2);
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("b");
      expect(events[1].type).toBe("c");
    });
  });

  describe("queryEvents", () => {
    beforeEach(async () => {
      await appendEvent(tmpDir, {
        type: "file:changed",
        actor: { type: "user" },
        data: { path: "src/index.ts" },
      });
      await appendEvent(tmpDir, {
        type: "agent:idle",
        actor: { type: "agent", id: "agent-1" },
        data: {},
      });
      await appendEvent(tmpDir, {
        type: "file:changed",
        actor: { type: "agent", id: "agent-2" },
        data: { path: "src/utils/helper.ts" },
      });
    });

    it("filters by eventType", async () => {
      const events = await queryEvents(tmpDir, {
        eventType: "file:changed",
      });
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.type === "file:changed")).toBe(true);
    });

    it("filters by actorType", async () => {
      const events = await queryEvents(tmpDir, { actorType: "agent" });
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.actor.type === "agent")).toBe(true);
    });

    it("filters by actorId", async () => {
      const events = await queryEvents(tmpDir, { actorId: "agent-1" });
      expect(events).toHaveLength(1);
      expect(events[0].actor.id).toBe("agent-1");
    });

    it("filters by path prefix", async () => {
      const events = await queryEvents(tmpDir, { path: "src/utils" });
      expect(events).toHaveLength(1);
      expect(events[0].data.path).toBe("src/utils/helper.ts");
    });

    it("filters by minutesAgo", async () => {
      // All events were just created, so they should all be within 1 minute
      const events = await queryEvents(tmpDir, { minutesAgo: 1 });
      expect(events).toHaveLength(3);

      // 0 minutes ago should return nothing (cutoff is now)
      const noEvents = await queryEvents(tmpDir, { minutesAgo: 0 });
      expect(noEvents).toHaveLength(3); // minutesAgo=0 skips the filter
    });

    it("applies limit", async () => {
      const events = await queryEvents(tmpDir, { limit: 1 });
      expect(events).toHaveLength(1);
    });

    it("combines multiple filters", async () => {
      const events = await queryEvents(tmpDir, {
        eventType: "file:changed",
        actorType: "agent",
      });
      expect(events).toHaveLength(1);
      expect(events[0].data.path).toBe("src/utils/helper.ts");
    });
  });

  describe("getAgentActivity", () => {
    it("reads agent metadata files", async () => {
      const agentsDir = join(tmpDir, ".workspace", "opencode", "agents");
      await mkdir(agentsDir, { recursive: true });

      const now = new Date().toISOString();
      await Bun.write(
        join(agentsDir, "agent-1.json"),
        JSON.stringify({
          agentId: "agent-1",
          name: "Test Agent",
          updatedAt: now,
        }),
      );
      await Bun.write(
        join(agentsDir, "agent-2.json"),
        JSON.stringify({
          agentId: "agent-2",
          name: "Another Agent",
          updatedAt: now,
        }),
      );

      const agents = await getAgentActivity(tmpDir, 30);
      expect(agents).toHaveLength(2);
      expect(agents[0].agentId).toBeDefined();
      expect(agents[0].name).toBeDefined();
    });

    it("filters by agentId", async () => {
      const agentsDir = join(tmpDir, ".workspace", "opencode", "agents");
      await mkdir(agentsDir, { recursive: true });

      const now = new Date().toISOString();
      await Bun.write(
        join(agentsDir, "agent-1.json"),
        JSON.stringify({ agentId: "agent-1", name: "A", updatedAt: now }),
      );
      await Bun.write(
        join(agentsDir, "agent-2.json"),
        JSON.stringify({ agentId: "agent-2", name: "B", updatedAt: now }),
      );

      const agents = await getAgentActivity(tmpDir, 30, "agent-1");
      expect(agents).toHaveLength(1);
      expect(agents[0].agentId).toBe("agent-1");
    });

    it("returns empty array when no agents dir", async () => {
      const agents = await getAgentActivity(tmpDir, 30);
      expect(agents).toEqual([]);
    });

    it("excludes stale agents", async () => {
      const agentsDir = join(tmpDir, ".workspace", "opencode", "agents");
      await mkdir(agentsDir, { recursive: true });

      const staleDate = new Date(Date.now() - 120 * 60 * 1000).toISOString(); // 2 hours ago
      await Bun.write(
        join(agentsDir, "old-agent.json"),
        JSON.stringify({
          agentId: "old-agent",
          name: "Old",
          updatedAt: staleDate,
        }),
      );

      const agents = await getAgentActivity(tmpDir, 30);
      expect(agents).toEqual([]);
    });
  });

  describe("getRecentFiles", () => {
    let repoDir: string;

    beforeEach(async () => {
      repoDir = await realpath(
        await mkdtemp(join(tmpdir(), "magents-git-events-test-")),
      );
      const git = (args: string[]) =>
        gitCmd(repoDir, args);

      await git(["init", "-b", "main"]);
      await git(["config", "user.email", "test@test.com"]);
      await git(["config", "user.name", "Test"]);
      await Bun.write(join(repoDir, "README.md"), "# Test\n");
      await git(["add", "README.md"]);
      await git(["commit", "-m", "initial"]);
    });

    afterEach(async () => {
      await rm(repoDir, { recursive: true, force: true });
    });

    it("returns recently modified files from git", async () => {
      await Bun.write(join(repoDir, "file1.ts"), "content1");
      await gitCmd(repoDir, ["add", "file1.ts"]);
      await gitCmd(repoDir, ["commit", "-m", "add file1"]);

      const files = await getRecentFiles(repoDir, 10);
      expect(files.length).toBeGreaterThan(0);
      expect(files.some((f) => f.path === "file1.ts")).toBe(true);
    });

    it("deduplicates files keeping most recent", async () => {
      await Bun.write(join(repoDir, "dup.ts"), "v1");
      await gitCmd(repoDir, ["add", "dup.ts"]);
      await gitCmd(repoDir, ["commit", "-m", "v1"]);

      await Bun.write(join(repoDir, "dup.ts"), "v2");
      await gitCmd(repoDir, ["add", "dup.ts"]);
      await gitCmd(repoDir, ["commit", "-m", "v2"]);

      const files = await getRecentFiles(repoDir, 10);
      const dupEntries = files.filter((f) => f.path === "dup.ts");
      expect(dupEntries).toHaveLength(1);
    });
  });

  describe("getDirectoryChanges", () => {
    let repoDir: string;

    beforeEach(async () => {
      repoDir = await realpath(
        await mkdtemp(join(tmpdir(), "magents-dir-changes-test-")),
      );
      await gitCmd(repoDir, ["init", "-b", "main"]);
      await gitCmd(repoDir, ["config", "user.email", "test@test.com"]);
      await gitCmd(repoDir, ["config", "user.name", "Test"]);
      await Bun.write(join(repoDir, "README.md"), "# Test\n");
      await gitCmd(repoDir, ["add", "README.md"]);
      await gitCmd(repoDir, ["commit", "-m", "initial"]);
    });

    afterEach(async () => {
      await rm(repoDir, { recursive: true, force: true });
    });

    it("returns changes scoped to directory", async () => {
      await mkdir(join(repoDir, "src"), { recursive: true });
      await Bun.write(join(repoDir, "src", "app.ts"), "app");
      await Bun.write(join(repoDir, "other.ts"), "other");
      await gitCmd(repoDir, ["add", "."]);
      await gitCmd(repoDir, ["commit", "-m", "add files"]);

      const changes = await getDirectoryChanges(repoDir, "src", 20);
      expect(changes.length).toBeGreaterThan(0);
      expect(changes.every((c) => c.path.startsWith("src/"))).toBe(true);
    });
  });

  describe("getWorkspaceSummary", () => {
    let repoDir: string;

    beforeEach(async () => {
      repoDir = await realpath(
        await mkdtemp(join(tmpdir(), "magents-summary-test-")),
      );
      await gitCmd(repoDir, ["init", "-b", "main"]);
      await gitCmd(repoDir, ["config", "user.email", "test@test.com"]);
      await gitCmd(repoDir, ["config", "user.name", "Test"]);
      await Bun.write(join(repoDir, "README.md"), "# Test\n");
      await gitCmd(repoDir, ["add", "README.md"]);
      await gitCmd(repoDir, ["commit", "-m", "initial"]);
    });

    afterEach(async () => {
      await rm(repoDir, { recursive: true, force: true });
    });

    it("returns combined summary data", async () => {
      // Add some events
      await appendEvent(repoDir, {
        type: "file:changed",
        actor: { type: "user" },
        data: {},
      });
      await appendEvent(repoDir, {
        type: "file:changed",
        actor: { type: "user" },
        data: {},
      });
      await appendEvent(repoDir, {
        type: "agent:idle",
        actor: { type: "agent" },
        data: {},
      });

      const summary = await getWorkspaceSummary(repoDir, 60);

      expect(summary.eventCountsByType).toBeDefined();
      expect(summary.eventCountsByType["file:changed"]).toBe(2);
      expect(summary.eventCountsByType["agent:idle"]).toBe(1);
      expect(typeof summary.activeAgentCount).toBe("number");
      expect(typeof summary.recentFileCount).toBe("number");
      expect(summary.gitStatus).toBeDefined();
    });
  });
});

async function gitCmd(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    },
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`);
  }
  return stdout.trimEnd();
}
