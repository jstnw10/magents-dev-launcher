import { describe, expect, it, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  getWorkspaceTemplate,
  getTaskFocusedTemplate,
  getTaskLoopTemplate,
  getPromptForAgent,
  generatePromptTemplates,
} from "./prompt-templates";

function tmpWorkspace(): string {
  return path.join(tmpdir(), `prompt-templates-test-${Bun.randomUUIDv7().slice(0, 8)}`);
}

describe("prompt-templates", () => {
  describe("getWorkspaceTemplate", () => {
    it("returns a non-empty string", () => {
      const template = getWorkspaceTemplate();
      expect(typeof template).toBe("string");
      expect(template.length).toBeGreaterThan(0);
    });

    it("contains expected workspace content", () => {
      const template = getWorkspaceTemplate();
      expect(template).toContain("Workspace Tools");
      expect(template).toContain("Agent Collaboration");
    });
  });

  describe("getTaskFocusedTemplate", () => {
    it("includes workspace template content", () => {
      const taskFocused = getTaskFocusedTemplate();
      const workspace = getWorkspaceTemplate();
      expect(taskFocused).toContain(workspace);
    });

    it("includes task-focused instructions", () => {
      const template = getTaskFocusedTemplate();
      expect(template).toContain("Task-Focused Agent");
      expect(template).toContain("no scope creep");
    });
  });

  describe("getTaskLoopTemplate", () => {
    it("contains the specialist role placeholder", () => {
      const template = getTaskLoopTemplate();
      expect(template).toContain("{SPECIALIST_ROLE_CONTENT}");
    });

    it("contains specialist_role tags", () => {
      const template = getTaskLoopTemplate();
      expect(template).toContain("<specialist_role>");
      expect(template).toContain("</specialist_role>");
    });

    it("includes workspace template content", () => {
      const template = getTaskLoopTemplate();
      const workspace = getWorkspaceTemplate();
      expect(template).toContain(workspace);
    });

    it("includes task loop instructions", () => {
      const template = getTaskLoopTemplate();
      expect(template).toContain("Task Loop Agent");
      expect(template).toContain("Single-Task Scope");
    });
  });

  describe("getPromptForAgent", () => {
    it("replaces placeholder with custom specialist prompt", () => {
      const result = getPromptForAgent("You are a code reviewer.");
      expect(result).toContain("You are a code reviewer.");
      expect(result).not.toContain("{SPECIALIST_ROLE_CONTENT}");
      // Should be wrapped in the task-loop template
      expect(result).toContain("<specialist_role>");
      expect(result).toContain("Task Loop Agent");
    });

    it("returns workspace template when systemPrompt is undefined", () => {
      const result = getPromptForAgent(undefined);
      const workspace = getWorkspaceTemplate();
      expect(result).toBe(workspace);
    });

    it("returns workspace template when systemPrompt is empty string", () => {
      const result = getPromptForAgent("");
      const workspace = getWorkspaceTemplate();
      expect(result).toBe(workspace);
    });
  });

  describe("generatePromptTemplates", () => {
    let workspacePath: string;

    afterEach(async () => {
      if (workspacePath) {
        await rm(workspacePath, { recursive: true, force: true });
      }
    });

    it("creates 3 prompt files in .workspace/prompts/", async () => {
      workspacePath = tmpWorkspace();
      await generatePromptTemplates(workspacePath);

      const promptsDir = path.join(workspacePath, ".workspace", "prompts");

      const workspaceFile = Bun.file(path.join(promptsDir, "workspace-latest.txt"));
      const taskFocusedFile = Bun.file(path.join(promptsDir, "task-focused-latest.txt"));
      const taskLoopFile = Bun.file(path.join(promptsDir, "task-loop-latest.txt"));

      expect(await workspaceFile.exists()).toBe(true);
      expect(await taskFocusedFile.exists()).toBe(true);
      expect(await taskLoopFile.exists()).toBe(true);

      // Verify content matches the template functions
      expect(await workspaceFile.text()).toBe(getWorkspaceTemplate());
      expect(await taskFocusedFile.text()).toBe(getTaskFocusedTemplate());
      expect(await taskLoopFile.text()).toBe(getTaskLoopTemplate());
    });

    it("creates directories recursively if they don't exist", async () => {
      workspacePath = tmpWorkspace();
      // Directory doesn't exist yet — should not throw
      await generatePromptTemplates(workspacePath);

      const promptsDir = path.join(workspacePath, ".workspace", "prompts");
      const file = Bun.file(path.join(promptsDir, "workspace-latest.txt"));
      expect(await file.exists()).toBe(true);
    });
  });
});

