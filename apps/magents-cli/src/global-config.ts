import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface MagentsGlobalConfig {
  convexDeployKey?: string;
  convexUrl?: string;
}

export function getMagentsRoot(): string {
  return process.env.MAGENTS_HOME ?? path.join(os.homedir(), ".magents");
}

function getConfigPath(): string {
  return path.join(getMagentsRoot(), "config.json");
}

export async function readGlobalConfig(): Promise<MagentsGlobalConfig> {
  try {
    const raw = await readFile(getConfigPath(), "utf-8");
    return JSON.parse(raw) as MagentsGlobalConfig;
  } catch {
    return {};
  }
}

export async function writeGlobalConfig(config: MagentsGlobalConfig): Promise<void> {
  const root = getMagentsRoot();
  await mkdir(root, { recursive: true });
  const configPath = getConfigPath();
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await chmod(configPath, 0o600);
}
