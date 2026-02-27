import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
} from "./subscription-storage";

describe("subscription-storage", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "magents-sub-test-")));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("createSubscription creates and stores a subscription", async () => {
    const sub = await createSubscription(tmpDir, {
      agentId: "agent-1",
      agentName: "Test Agent",
      eventTypes: ["agent:*", "file:*"],
    });

    expect(sub.id).toBeDefined();
    expect(sub.agentId).toBe("agent-1");
    expect(sub.eventTypes).toEqual(["agent:*", "file:*"]);
    expect(sub.createdAt).toBeDefined();

    // Verify it's persisted
    const loaded = await getSubscription(tmpDir, sub.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(sub.id);
  });

  it("getSubscription returns null for nonexistent subscription", async () => {
    const result = await getSubscription(tmpDir, "nonexistent-id");
    expect(result).toBeNull();
  });

  it("deleteSubscription removes a subscription", async () => {
    const sub = await createSubscription(tmpDir, {
      agentId: "agent-1",
      agentName: "Test Agent",
      eventTypes: ["agent:*"],
    });

    const removed = await deleteSubscription(tmpDir, sub.id);
    expect(removed).toBe(true);

    const loaded = await getSubscription(tmpDir, sub.id);
    expect(loaded).toBeNull();
  });

  it("deleteSubscription returns false for nonexistent subscription", async () => {
    const removed = await deleteSubscription(tmpDir, "nonexistent-id");
    expect(removed).toBe(false);
  });

  it("listSubscriptions returns all subscriptions", async () => {
    await createSubscription(tmpDir, {
      agentId: "agent-1",
      agentName: "Agent 1",
      eventTypes: ["agent:*"],
    });
    await createSubscription(tmpDir, {
      agentId: "agent-2",
      agentName: "Agent 2",
      eventTypes: ["file:*"],
    });

    const subs = await listSubscriptions(tmpDir);
    expect(subs).toHaveLength(2);
    expect(subs.map((s) => s.agentId).sort()).toEqual(["agent-1", "agent-2"]);
  });

  it("listSubscriptions returns empty for no subscriptions", async () => {
    const subs = await listSubscriptions(tmpDir);
    expect(subs).toHaveLength(0);
  });

  describe("path traversal defense", () => {
    it("getSubscription rejects traversal IDs", async () => {
      expect(() => getSubscription(tmpDir, "../../etc/passwd")).toThrow("Invalid ID");
    });

    it("deleteSubscription rejects traversal IDs", async () => {
      expect(() => deleteSubscription(tmpDir, "../secret")).toThrow("Invalid ID");
    });
  });
});
