import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { WorktreeManager } from "./types";

export class GitWorktreeManager implements WorktreeManager {
  async provision(input: { sessionId: string; sourceRoot: string; requestedPath?: string }) {
    const targetPath = input.requestedPath ?? path.join(input.sourceRoot, ".magents", input.sessionId);
    await mkdir(path.dirname(targetPath), { recursive: true });
    return targetPath;
  }

  async cleanup(_input: { sourceRoot: string; path: string }) {
    // Worktree cleanup is intentionally hook-only in this wave.
  }
}
