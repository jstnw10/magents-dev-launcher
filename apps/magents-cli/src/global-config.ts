import { mkdir, chmod } from "node:fs/promises";
import path from "node:path";

export interface MagentsGlobalConfig {
  convexDeployKey?: string;
  convexUrl?: string;
  opencodePath?: string;
}

export function getMagentsRoot(): string {
  return process.env.MAGENTS_HOME ?? path.join(Bun.env.HOME ?? "/tmp", ".magents");
}

function getConfigPath(): string {
  return path.join(getMagentsRoot(), "config.json");
}

export async function readGlobalConfig(): Promise<MagentsGlobalConfig> {
  try {
    return await Bun.file(getConfigPath()).json() as MagentsGlobalConfig;
  } catch {
    return {};
  }
}

export async function writeGlobalConfig(config: MagentsGlobalConfig): Promise<void> {
  const root = getMagentsRoot();
  await mkdir(root, { recursive: true });
  const configPath = getConfigPath();
  await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n");
  await chmod(configPath, 0o600);
}
