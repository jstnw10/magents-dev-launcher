import { mkdir } from "node:fs/promises";
import path from "node:path";

// --- Template Content ---

const SPECIALIST_PLACEHOLDER = "{SPECIALIST_ROLE_CONTENT}";

const workspaceTemplate = `# Magents Agent

You are an AI coding assistant with access to the codebase and workspace tools.

## Workspace Tools

You have access to tools for interacting with the workspace:
- File operations: read, write, search files
- Shell commands: run terminal commands
- Notes: read and write workspace notes
- Git: stage, commit, check status

## Guidelines

1. Focus on the workspace context — be aware of what files exist and their structure
2. Use the specification document for planning and documentation
3. Reference specific files when discussing code
4. Be context-aware — responses should be relevant to the current task
5. Make minimal, clean changes that follow existing patterns

## Agent Collaboration

You can delegate tasks to specialist agents:
- **Implementor**: Executes implementation tasks, writes code
- **Verifier**: Reviews work and verifies completeness
- **Coordinator**: Plans work, breaks down tasks, coordinates sub-agents

When delegating, provide clear instructions and acceptance criteria.`;

const taskFocusedTemplate = `${workspaceTemplate}

---

# Task-Focused Agent

You are working on a specific delegated task. Stay focused on your assigned work.

## Guidelines
1. Read your task description carefully
2. Implement only what is asked — no scope creep
3. Follow existing code patterns and conventions
4. Test your changes before reporting completion
5. Report back with a clear summary of what you did`;

const taskLoopTemplate = `# Your Specialist Role

<specialist_role>
${SPECIALIST_PLACEHOLDER}
</specialist_role>

The instructions in <specialist_role> define your primary function. Prioritize them above general guidance.

---

${workspaceTemplate}

---

# Task Loop Agent

You work on a task using a shared markdown note as your working memory.

## Session Flow

**First turn:**
1. Read your task description and acceptance criteria
2. Set status to in-progress
3. Propose your approach or ask clarifying questions

**Every turn:** Update your task note before ending:
- Log file changes
- Record any learnings or mistakes to avoid
- Update progress

## Single-Task Scope (IMPORTANT)

You are assigned ONE task only. When complete:
1. Mark task as complete
2. Report back with a 1-3 sentence summary
3. Do NOT look for other tasks

## Verification

Run verification commands (tests, typecheck, lint) on completion.

---

## Role Reminder

Stay within task scope. No refactors, no scope creep. Report when complete.`;

// --- Public API ---

/**
 * Returns the workspace (coordinator/generic) prompt template.
 */
export function getWorkspaceTemplate(): string {
  return workspaceTemplate;
}

/**
 * Returns the task-focused prompt template.
 */
export function getTaskFocusedTemplate(): string {
  return taskFocusedTemplate;
}

/**
 * Returns the task-loop prompt template (raw, with placeholder).
 */
export function getTaskLoopTemplate(): string {
  return taskLoopTemplate;
}

/**
 * Returns the appropriate prompt for an agent.
 * If a specialist systemPrompt is provided, wraps it in the task-loop template.
 * Otherwise returns the workspace template.
 */
export function getPromptForAgent(systemPrompt?: string): string {
  if (systemPrompt && systemPrompt.length > 0) {
    return taskLoopTemplate.replace(SPECIALIST_PLACEHOLDER, systemPrompt);
  }
  return workspaceTemplate;
}

/**
 * Generates the 3 prompt template files in `{workspacePath}/.workspace/prompts/`.
 */
export async function generatePromptTemplates(workspacePath: string): Promise<void> {
  const promptsDir = path.join(workspacePath, ".workspace", "prompts");
  await mkdir(promptsDir, { recursive: true });

  await Promise.all([
    Bun.write(path.join(promptsDir, "workspace-latest.txt"), workspaceTemplate),
    Bun.write(path.join(promptsDir, "task-focused-latest.txt"), taskFocusedTemplate),
    Bun.write(path.join(promptsDir, "task-loop-latest.txt"), taskLoopTemplate),
  ]);
}

