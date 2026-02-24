import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SessionRecord, SessionRegistry } from "./types";

interface RegistryDocument {
  readonly version: 1;
  readonly sessions: SessionRecord[];
}

function defaultRegistryPath() {
  if (process.env.MAGENTS_CLI_REGISTRY_PATH) {
    return process.env.MAGENTS_CLI_REGISTRY_PATH;
  }

  return path.join(os.homedir(), ".magents", "sessions.json");
}

export class FileSessionRegistry implements SessionRegistry {
  constructor(readonly filePath = defaultRegistryPath()) {}

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      if (raw.trim().length === 0) {
        return [];
      }
      const parsed = JSON.parse(raw) as RegistryDocument;
      return parsed.sessions ?? [];
    } catch (error) {
      const maybeCode = (error as { code?: string }).code;
      if (maybeCode === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  async save(sessions: SessionRecord[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const payload: RegistryDocument = {
      version: 1,
      sessions,
    };
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}
