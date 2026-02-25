import { mkdir } from "node:fs/promises";
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

  return path.join(Bun.env.HOME ?? "/tmp", ".magents", "sessions.json");
}

export class FileSessionRegistry implements SessionRegistry {
  constructor(readonly filePath = defaultRegistryPath()) {}

  async load() {
    const file = Bun.file(this.filePath);
    if (!(await file.exists())) {
      return [];
    }
    const raw = await file.text();
    if (raw.trim().length === 0) {
      return [];
    }
    const parsed = JSON.parse(raw) as RegistryDocument;
    return parsed.sessions ?? [];
  }

  async save(sessions: SessionRecord[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const payload: RegistryDocument = {
      version: 1,
      sessions,
    };
    await Bun.write(this.filePath, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
