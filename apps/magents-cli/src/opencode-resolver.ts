import {
  readGlobalConfig,
  writeGlobalConfig,
  type MagentsGlobalConfig,
} from "./global-config";
import { OrchestrationError } from "./types";

export interface OpencodeResolverDeps {
  exec: (cmd: string) => Promise<{ stdout: string; stderr: string }>;
  readConfig: () => Promise<MagentsGlobalConfig>;
  writeConfig: (config: MagentsGlobalConfig) => Promise<void>;
}

export interface ResolvedOpencode {
  path: string;
  version: string;
  source: "config" | "auto-detected";
}

function defaultDeps(): OpencodeResolverDeps {
  return {
    exec: async (cmd: string) => {
      const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      if (exitCode !== 0) {
        throw new Error(stderr || `Command failed with exit code ${exitCode}`);
      }
      return { stdout, stderr };
    },
    readConfig: readGlobalConfig,
    writeConfig: writeGlobalConfig,
  };
}

/**
 * Runs `<binaryPath> --version` and returns the trimmed version string.
 */
export async function getOpencodeVersion(
  binaryPath: string,
  deps?: Partial<OpencodeResolverDeps>,
): Promise<string> {
  const { exec } = { ...defaultDeps(), ...deps };
  let stdout: string;
  try {
    const result = await exec(`${binaryPath} --version`);
    stdout = result.stdout;
  } catch (err) {
    throw new OrchestrationError(
      "OPENCODE_VALIDATION_FAILED",
      `Failed to get opencode version at "${binaryPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const version = stdout.trim();
  if (!version) {
    throw new OrchestrationError(
      "OPENCODE_VALIDATION_FAILED",
      `"${binaryPath} --version" returned empty output.`,
    );
  }
  return version;
}

/**
 * Validates an opencode binary path by running --version and --help.
 */
async function validateBinary(
  binaryPath: string,
  exec: OpencodeResolverDeps["exec"],
): Promise<string> {
  let version: string;
  try {
    const { stdout } = await exec(`${binaryPath} --version`);
    version = stdout.trim();
    if (!version) {
      throw new Error("empty version output");
    }
  } catch (err) {
    throw new OrchestrationError(
      "OPENCODE_VALIDATION_FAILED",
      `Failed to validate opencode at "${binaryPath}": --version check failed. ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const { stdout } = await exec(`${binaryPath} --help`);
    if (!stdout.trim()) {
      throw new Error("empty help output");
    }
  } catch (err) {
    throw new OrchestrationError(
      "OPENCODE_VALIDATION_FAILED",
      `Failed to validate opencode at "${binaryPath}": --help check failed. ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return version;
}

/**
 * Auto-detects the opencode binary via `which opencode`, ignoring config.
 * Returns the path or null if not found.
 */
export async function detectOpencodePath(
  deps?: Partial<OpencodeResolverDeps>,
): Promise<string | null> {
  const { exec } = { ...defaultDeps(), ...deps };
  try {
    const { stdout } = await exec("which opencode");
    const detected = stdout.trim();
    return detected || null;
  } catch {
    return null;
  }
}

/**
 * Resolves the opencode binary path. Checks global config first for a manually
 * set path, then falls back to auto-detection via `which opencode`. Validates
 * the found path by running --version and --help.
 */
export async function resolveOpencodePath(
  deps?: Partial<OpencodeResolverDeps>,
): Promise<ResolvedOpencode> {
  const merged = { ...defaultDeps(), ...deps };

  // Check global config first
  const config = await merged.readConfig();
  if (config.opencodePath) {
    const version = await validateBinary(config.opencodePath, merged.exec);
    return { path: config.opencodePath, version, source: "config" };
  }

  // Fall back to auto-detection
  const detected = await detectOpencodePath(merged);
  if (!detected) {
    throw new OrchestrationError(
      "OPENCODE_NOT_FOUND",
      "opencode is not installed or not found in PATH. Install it from https://opencode.ai or set the path manually with `magents config set opencodePath <path>`.",
    );
  }

  const version = await validateBinary(detected, merged.exec);
  return { path: detected, version, source: "auto-detected" };
}

/**
 * Validates the given path and persists it to global config.
 */
export async function setOpencodePath(
  binaryPath: string,
  deps?: Partial<OpencodeResolverDeps>,
): Promise<{ path: string; version: string }> {
  const merged = { ...defaultDeps(), ...deps };

  const version = await validateBinary(binaryPath, merged.exec);

  const config = await merged.readConfig();
  config.opencodePath = binaryPath;
  await merged.writeConfig(config);

  return { path: binaryPath, version };
}
