import { mkdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OrchestrationError } from "./types";

// --- Interfaces ---

export interface SpecialistDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  modelTier?: string;
  roleReminder?: string;
  defaultModel?: string;
  source: "builtin" | "user";
}

export interface InteractiveIO {
  prompt(question: string): Promise<string>;
  openEditor(initialContent?: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
}

// --- Frontmatter parsing ---

interface Frontmatter {
  name: string;
  description: string;
  modelTier?: string;
  roleReminder?: string;
  defaultModel?: string;
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } | null {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return null;
  }

  const firstNewline = content.indexOf("\n");
  const rest = content.slice(firstNewline + 1);
  const closingIndex = rest.indexOf("\n---");
  if (closingIndex < 0) {
    return null;
  }

  const frontmatterBlock = rest.slice(0, closingIndex);
  // Body starts after the closing --- and its newline
  const afterClosing = rest.slice(closingIndex + 4); // "\n---" is 4 chars
  // Skip the newline after closing ---
  const body = afterClosing.startsWith("\n")
    ? afterClosing.slice(1)
    : afterClosing.startsWith("\r\n")
      ? afterClosing.slice(2)
      : afterClosing;

  const fields: Record<string, string> = {};
  for (const line of frontmatterBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex < 0) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    let value = trimmed.slice(colonIndex + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    fields[key] = value;
  }

  if (!fields.name || !fields.description) {
    return null;
  }

  return {
    frontmatter: {
      name: fields.name,
      description: fields.description,
      modelTier: fields.modelTier,
      roleReminder: fields.roleReminder,
      defaultModel: fields.defaultModel,
    },
    body: body.trim(),
  };
}

// --- SpecialistRegistry ---

export class SpecialistRegistry {
  private readonly builtinDir: string;
  private readonly userDir: string;

  constructor(options?: { builtinDir?: string; userDir?: string }) {
    this.builtinDir =
      options?.builtinDir ?? path.resolve(import.meta.dir, "..", "specialists");
    this.userDir =
      options?.userDir ?? path.join(os.homedir(), ".magents", "specialists");
  }

  async list(): Promise<SpecialistDefinition[]> {
    const builtinSpecs = await this.scanDir(this.builtinDir, "builtin");
    const userSpecs = await this.scanDir(this.userDir, "user");

    // Merge: user overrides builtin by filename
    const merged = new Map<string, SpecialistDefinition>();
    for (const [id, def] of builtinSpecs) {
      merged.set(id, def);
    }
    for (const [id, def] of userSpecs) {
      merged.set(id, def);
    }

    return Array.from(merged.values());
  }

  async get(id: string): Promise<SpecialistDefinition | null> {
    // Check user dir first (takes priority)
    const userDef = await this.readDefinition(this.userDir, id, "user");
    if (userDef) return userDef;

    // Fall back to builtin
    const builtinDef = await this.readDefinition(this.builtinDir, id, "builtin");
    return builtinDef;
  }

  async add(id: string, content: string): Promise<void> {
    await mkdir(this.userDir, { recursive: true });
    const filePath = path.join(this.userDir, `${id}.md`);
    await Bun.write(filePath, content);
  }

  async remove(id: string): Promise<void> {
    // Check if it's a builtin-only specialist (no user override)
    const userFile = Bun.file(path.join(this.userDir, `${id}.md`));
    if (!(await userFile.exists())) {
      // Check if it's a builtin
      const builtinFile = Bun.file(path.join(this.builtinDir, `${id}.md`));
      if (await builtinFile.exists()) {
        throw new OrchestrationError(
          "BUILTIN_SPECIALIST",
          `Cannot remove built-in specialist "${id}". Only user-defined specialists can be removed.`,
        );
      }
      throw new OrchestrationError(
        "SPECIALIST_NOT_FOUND",
        `Specialist "${id}" not found.`,
      );
    }
    await unlink(path.join(this.userDir, `${id}.md`));
  }

  private async scanDir(
    dir: string,
    source: "builtin" | "user",
  ): Promise<Map<string, SpecialistDefinition>> {
    const results = new Map<string, SpecialistDefinition>();
    try {
      const glob = new Bun.Glob("*.md");
      for await (const entry of glob.scan({ cwd: dir })) {
        const id = entry.replace(/\.md$/, "");
        const file = Bun.file(path.join(dir, entry));
        const raw = await file.text();
        const parsed = parseFrontmatter(raw);
        if (!parsed) continue;

        results.set(id, {
          id,
          name: parsed.frontmatter.name,
          description: parsed.frontmatter.description,
          systemPrompt: parsed.body,
          modelTier: parsed.frontmatter.modelTier,
          roleReminder: parsed.frontmatter.roleReminder,
          defaultModel: parsed.frontmatter.defaultModel,
          source,
        });
      }
    } catch {
      // Directory doesn't exist or can't be read — return empty
    }
    return results;
  }

  private async readDefinition(
    dir: string,
    id: string,
    source: "builtin" | "user",
  ): Promise<SpecialistDefinition | null> {
    const filePath = path.join(dir, `${id}.md`);
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    const raw = await file.text();
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;

    return {
      id,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      systemPrompt: parsed.body,
      modelTier: parsed.frontmatter.modelTier,
      roleReminder: parsed.frontmatter.roleReminder,
      defaultModel: parsed.frontmatter.defaultModel,
      source,
    };
  }
}
