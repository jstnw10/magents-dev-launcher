import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SpecialistRegistry } from "./specialist-registry";

let builtinDir: string;
let userDir: string;

beforeEach(async () => {
  builtinDir = await mkdtemp(path.join(os.tmpdir(), "magents-builtin-"));
  userDir = await mkdtemp(path.join(os.tmpdir(), "magents-user-"));
});

afterEach(async () => {
  await rm(builtinDir, { recursive: true, force: true });
  await rm(userDir, { recursive: true, force: true });
});

function makeSpecialistMd(opts: {
  name: string;
  description: string;
  modelTier?: string;
  roleReminder?: string;
  defaultModel?: string;
  body: string;
}): string {
  const lines = ["---"];
  lines.push(`name: "${opts.name}"`);
  lines.push(`description: "${opts.description}"`);
  if (opts.modelTier) lines.push(`modelTier: "${opts.modelTier}"`);
  if (opts.roleReminder) lines.push(`roleReminder: "${opts.roleReminder}"`);
  if (opts.defaultModel) lines.push(`defaultModel: "${opts.defaultModel}"`);
  lines.push("---");
  lines.push("");
  lines.push(opts.body);
  return lines.join("\n");
}

async function writeSpecialist(dir: string, id: string, content: string) {
  await Bun.write(path.join(dir, `${id}.md`), content);
}

describe("SpecialistRegistry", () => {
  it("list() reads .md files from built-in dir", async () => {
    await writeSpecialist(
      builtinDir,
      "coordinator",
      makeSpecialistMd({
        name: "Coordinator",
        description: "Plans and delegates",
        modelTier: "smart",
        body: "You are a coordinator.",
      }),
    );
    await writeSpecialist(
      builtinDir,
      "implementor",
      makeSpecialistMd({
        name: "Implementor",
        description: "Writes code",
        modelTier: "smart",
        body: "You are an implementor.",
      }),
    );

    const registry = new SpecialistRegistry({ builtinDir, userDir });
    const specialists = await registry.list();

    expect(specialists).toHaveLength(2);
    expect(specialists.map((s) => s.id).sort()).toEqual(["coordinator", "implementor"]);
    expect(specialists.every((s) => s.source === "builtin")).toBe(true);
  });

  it("list() merges user + built-in, user overrides", async () => {
    await writeSpecialist(
      builtinDir,
      "coordinator",
      makeSpecialistMd({
        name: "Coordinator",
        description: "Built-in coordinator",
        body: "Built-in prompt.",
      }),
    );
    await writeSpecialist(
      userDir,
      "coordinator",
      makeSpecialistMd({
        name: "My Coordinator",
        description: "Custom coordinator",
        body: "Custom prompt.",
      }),
    );
    await writeSpecialist(
      builtinDir,
      "verifier",
      makeSpecialistMd({
        name: "Verifier",
        description: "Built-in verifier",
        body: "Verify things.",
      }),
    );

    const registry = new SpecialistRegistry({ builtinDir, userDir });
    const specialists = await registry.list();

    expect(specialists).toHaveLength(2);

    const coordinator = specialists.find((s) => s.id === "coordinator");
    expect(coordinator).toBeDefined();
    expect(coordinator!.name).toBe("My Coordinator");
    expect(coordinator!.source).toBe("user");
    expect(coordinator!.systemPrompt).toBe("Custom prompt.");

    const verifier = specialists.find((s) => s.id === "verifier");
    expect(verifier).toBeDefined();
    expect(verifier!.source).toBe("builtin");
  });

  it("get() returns correct specialist by id", async () => {
    await writeSpecialist(
      builtinDir,
      "coordinator",
      makeSpecialistMd({
        name: "Coordinator",
        description: "Plans and delegates",
        modelTier: "smart",
        defaultModel: "claude-sonnet-4-5-20250929",
        body: "You are a coordinator.",
      }),
    );

    const registry = new SpecialistRegistry({ builtinDir, userDir });
    const specialist = await registry.get("coordinator");

    expect(specialist).not.toBeNull();
    expect(specialist!.id).toBe("coordinator");
    expect(specialist!.name).toBe("Coordinator");
    expect(specialist!.description).toBe("Plans and delegates");
    expect(specialist!.systemPrompt).toBe("You are a coordinator.");
    expect(specialist!.modelTier).toBe("smart");
    expect(specialist!.defaultModel).toBe("claude-sonnet-4-5-20250929");
    expect(specialist!.source).toBe("builtin");
  });

  it("get() returns user override when both exist", async () => {
    await writeSpecialist(
      builtinDir,
      "coordinator",
      makeSpecialistMd({
        name: "Coordinator",
        description: "Built-in",
        body: "Built-in prompt.",
      }),
    );
    await writeSpecialist(
      userDir,
      "coordinator",
      makeSpecialistMd({
        name: "My Coordinator",
        description: "User override",
        body: "Custom prompt.",
      }),
    );

    const registry = new SpecialistRegistry({ builtinDir, userDir });
    const specialist = await registry.get("coordinator");

    expect(specialist).not.toBeNull();
    expect(specialist!.name).toBe("My Coordinator");
    expect(specialist!.source).toBe("user");
  });

  it("get() returns null for unknown id", async () => {
    const registry = new SpecialistRegistry({ builtinDir, userDir });
    const specialist = await registry.get("nonexistent");
    expect(specialist).toBeNull();
  });

  it("frontmatter parsing: extracts name, description, modelTier, roleReminder", async () => {
    await writeSpecialist(
      builtinDir,
      "test-specialist",
      makeSpecialistMd({
        name: "Test Specialist",
        description: "A test specialist",
        modelTier: "fast",
        roleReminder: "Stay focused.",
        body: "## System Prompt\n\nDo the thing.",
      }),
    );

    const registry = new SpecialistRegistry({ builtinDir, userDir });
    const specialist = await registry.get("test-specialist");

    expect(specialist).not.toBeNull();
    expect(specialist!.name).toBe("Test Specialist");
    expect(specialist!.description).toBe("A test specialist");
    expect(specialist!.modelTier).toBe("fast");
    expect(specialist!.roleReminder).toBe("Stay focused.");
  });

  it("system prompt extraction: everything after frontmatter", async () => {
    const body = "## Coordinator\n\nYou plan, delegate, and verify.\nYou do NOT implement code yourself.";
    await writeSpecialist(
      builtinDir,
      "coordinator",
      makeSpecialistMd({
        name: "Coordinator",
        description: "Plans work",
        body,
      }),
    );

    const registry = new SpecialistRegistry({ builtinDir, userDir });
    const specialist = await registry.get("coordinator");

    expect(specialist).not.toBeNull();
    expect(specialist!.systemPrompt).toBe(body);
  });

  it("add() writes .md file to user dir", async () => {
    const registry = new SpecialistRegistry({ builtinDir, userDir });

    const content = makeSpecialistMd({
      name: "My Reviewer",
      description: "Reviews code",
      modelTier: "smart",
      body: "Review code carefully.",
    });
    await registry.add("my-reviewer", content);

    const file = Bun.file(path.join(userDir, "my-reviewer.md"));
    expect(await file.exists()).toBe(true);

    const raw = await file.text();
    expect(raw).toBe(content);

    // Also verify it appears in list
    const specialists = await registry.list();
    const found = specialists.find((s) => s.id === "my-reviewer");
    expect(found).toBeDefined();
    expect(found!.source).toBe("user");
    expect(found!.name).toBe("My Reviewer");
  });

  it("add() creates user dir if it doesn't exist", async () => {
    const nestedUserDir = path.join(userDir, "nested", "specialists");
    const registry = new SpecialistRegistry({ builtinDir, userDir: nestedUserDir });

    const content = makeSpecialistMd({
      name: "Test",
      description: "Test specialist",
      body: "Test prompt.",
    });
    await registry.add("test-specialist", content);

    const file = Bun.file(path.join(nestedUserDir, "test-specialist.md"));
    expect(await file.exists()).toBe(true);
  });

  it("remove() deletes from user dir", async () => {
    const content = makeSpecialistMd({
      name: "My Reviewer",
      description: "Reviews code",
      body: "Review prompt.",
    });
    await writeSpecialist(userDir, "my-reviewer", content);

    const registry = new SpecialistRegistry({ builtinDir, userDir });

    // Confirm it exists first
    const before = await registry.get("my-reviewer");
    expect(before).not.toBeNull();

    await registry.remove("my-reviewer");

    const file = Bun.file(path.join(userDir, "my-reviewer.md"));
    expect(await file.exists()).toBe(false);

    const after = await registry.get("my-reviewer");
    expect(after).toBeNull();
  });

  it("remove() refuses for built-in specialists", async () => {
    await writeSpecialist(
      builtinDir,
      "coordinator",
      makeSpecialistMd({
        name: "Coordinator",
        description: "Built-in coordinator",
        body: "Coordinator prompt.",
      }),
    );

    const registry = new SpecialistRegistry({ builtinDir, userDir });

    expect(registry.remove("coordinator")).rejects.toThrow("Cannot remove built-in specialist");
  });

  it("remove() throws for nonexistent specialists", async () => {
    const registry = new SpecialistRegistry({ builtinDir, userDir });

    expect(registry.remove("nonexistent")).rejects.toThrow("not found");
  });

  it("list() returns empty when directories don't exist", async () => {
    const registry = new SpecialistRegistry({
      builtinDir: "/tmp/nonexistent-builtin-dir-12345",
      userDir: "/tmp/nonexistent-user-dir-12345",
    });
    const specialists = await registry.list();
    expect(specialists).toHaveLength(0);
  });

  it("handles unquoted frontmatter values", async () => {
    const content = "---\nname: Coordinator\ndescription: Plans and delegates\nmodelTier: smart\n---\n\nSystem prompt here.";
    await writeSpecialist(builtinDir, "coordinator", content);

    const registry = new SpecialistRegistry({ builtinDir, userDir });
    const specialist = await registry.get("coordinator");

    expect(specialist).not.toBeNull();
    expect(specialist!.name).toBe("Coordinator");
    expect(specialist!.description).toBe("Plans and delegates");
    expect(specialist!.modelTier).toBe("smart");
    expect(specialist!.systemPrompt).toBe("System prompt here.");
  });
});
