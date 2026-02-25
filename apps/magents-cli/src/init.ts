import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as readline from "node:readline";

import { readGlobalConfig, writeGlobalConfig } from "./global-config";
import { OrchestrationError } from "./types";

/**
 * Deploy key format: `<type>:<deployment-name>|<jwt-token>`
 * where type is one of: dev, prod, preview, project
 */
const DEPLOY_KEY_PATTERN = /^(dev|prod|preview|project):[^|]+\|.+$/;

export function validateDeployKey(key: string): boolean {
  return DEPLOY_KEY_PATTERN.test(key);
}

export function redactDeployKey(key: string): string {
  if (key.length <= 20) {
    return key;
  }
  return key.slice(0, 20) + "...";
}

export async function validateConvexUrl(url: string): Promise<void> {
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok && response.status !== 405) {
      throw new OrchestrationError(
        "INVALID_URL",
        `Convex URL returned HTTP ${response.status}. Check the URL and try again.`,
      );
    }
  } catch (error) {
    if (error instanceof OrchestrationError) throw error;
    throw new OrchestrationError(
      "UNREACHABLE_URL",
      `Could not reach ${url}. Check the URL and your network connection.`,
    );
  }
}

function runConvexPush(deployKey: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["convex", "dev", "--once"], {
      env: { ...process.env, CONVEX_DEPLOY_KEY: deployKey },
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: stderr.trim() || `Process exited with code ${code}` });
      }
    });
  });
}

/**
 * Parse a CONVEX_DEPLOYMENT value like "dev:some-name-123" and derive
 * the Convex cloud URL: https://some-name-123.convex.cloud
 */
export function deriveUrlFromDeployment(deployment: string): string | null {
  const match = deployment.match(/^(?:dev|prod|preview|project):(.+)$/);
  if (!match) return null;
  return `https://${match[1]}.convex.cloud`;
}

/**
 * Read .env.local and extract CONVEX_DEPLOYMENT value.
 */
async function defaultReadEnvLocal(): Promise<string | null> {
  try {
    const content = await readFile(".env.local", "utf-8");
    const match = content.match(/^CONVEX_DEPLOYMENT=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function defaultRunConvexSetup(): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["convex", "dev", "--configure", "new", "--once"], {
      stdio: "inherit",
      shell: true,
    });

    child.on("error", () => {
      resolve({ exitCode: 1 });
    });

    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1 });
    });
  });
}

export interface InitDeps {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly validateUrl?: (url: string) => Promise<void>;
  readonly pushConvex?: (deployKey: string) => Promise<{ ok: boolean; error?: string }>;
  readonly prompt?: (question: string) => Promise<string>;
  readonly runConvexSetup?: () => Promise<{ exitCode: number }>;
  readonly readEnvLocal?: () => Promise<string | null>;
}

export async function handleInit(
  args: readonly string[],
  deps: InitDeps,
): Promise<number> {
  const isStatus = args.includes("--status");

  if (isStatus) {
    return handleStatus(deps);
  }

  return handleSetup(args, deps);
}

async function handleStatus(deps: InitDeps): Promise<number> {
  const config = await readGlobalConfig();

  if (!config.convexDeployKey && !config.convexUrl) {
    deps.stderr("No configuration found. Run `magents init --deploy-key KEY --url URL` to set up.");
    return 1;
  }

  const display = {
    convexDeployKey: config.convexDeployKey ? redactDeployKey(config.convexDeployKey) : undefined,
    convexUrl: config.convexUrl,
  };

  deps.stdout(JSON.stringify(display, null, 2));
  return 0;
}

function parseInitValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

async function handleSetup(args: readonly string[], deps: InitDeps): Promise<number> {
  const deployKey = parseInitValue(args, "--deploy-key");
  const url = parseInitValue(args, "--url");

  // If neither flag is provided, start interactive mode
  if (!deployKey && !url) {
    return handleInteractiveSetup(deps);
  }

  if (!deployKey) {
    throw new OrchestrationError("INVALID_ARGUMENT", "Missing required flag --deploy-key.");
  }

  if (!url) {
    throw new OrchestrationError("INVALID_ARGUMENT", "Missing required flag --url.");
  }

  if (!validateDeployKey(deployKey)) {
    throw new OrchestrationError(
      "INVALID_DEPLOY_KEY",
      `Invalid deploy key format. Expected "<type>:<name>|<token>" where type is dev, prod, preview, or project.`,
    );
  }

  // Validate URL reachability (best-effort)
  const doValidateUrl = deps.validateUrl ?? validateConvexUrl;
  try {
    await doValidateUrl(url);
  } catch (error) {
    if (error instanceof OrchestrationError) {
      throw error;
    }
    throw new OrchestrationError(
      "UNREACHABLE_URL",
      `Could not reach ${url}. Check the URL and your network connection.`,
    );
  }

  return saveAndPush(deployKey, url, deps);
}

async function saveAndPush(deployKey: string, url: string, deps: InitDeps): Promise<number> {
  await writeGlobalConfig({ convexDeployKey: deployKey, convexUrl: url });
  deps.stdout("Configuration saved.");

  const doPush = deps.pushConvex ?? runConvexPush;
  deps.stdout("Running convex dev --once...");
  const pushResult = await doPush(deployKey);

  if (pushResult.ok) {
    deps.stdout("Convex push succeeded.");
  } else {
    deps.stderr(
      `Warning: Convex push failed: ${pushResult.error ?? "unknown error"}. You can retry with: npx convex dev --once`,
    );
  }

  deps.stdout(
    JSON.stringify({
      configured: true,
      convexUrl: url,
      convexPush: pushResult.ok ? "success" : "failed",
    }, null, 2),
  );

  return 0;
}

function createDefaultPrompt(): { prompt: (question: string) => Promise<string>; close: () => void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    prompt: (question: string) =>
      new Promise((resolve) => {
        rl.question(question, (answer) => {
          resolve(answer.trim());
        });
      }),
    close: () => rl.close(),
  };
}

const CONVEX_URL_PATTERN = /^https:\/\/.+\.convex\.cloud\/?$/;

export function validateConvexUrlFormat(url: string): boolean {
  return CONVEX_URL_PATTERN.test(url);
}

async function handleInteractiveSetup(deps: InitDeps): Promise<number> {
  const defaultPrompt = deps.prompt ? null : createDefaultPrompt();
  const ask = deps.prompt ?? defaultPrompt!.prompt;

  try {
    deps.stdout("Welcome to Magents setup!\n");

    // Step 1: Ask if the user has an existing Convex deployment
    let hasExisting: string;
    for (;;) {
      hasExisting = await ask("Do you have an existing Convex deployment? (yes/no): ");
      const normalized = hasExisting.toLowerCase();
      if (normalized === "yes" || normalized === "no") {
        hasExisting = normalized;
        break;
      }
      deps.stderr('Please answer "yes" or "no".');
    }

    // Step 2: If new project, run Convex setup
    let derivedUrl: string | null = null;
    if (hasExisting === "no") {
      deps.stdout("We'll set up a new Convex project. This will open your browser for authentication.");

      const doSetup = deps.runConvexSetup ?? defaultRunConvexSetup;
      const result = await doSetup();

      if (result.exitCode !== 0) {
        deps.stderr(
          `Convex project setup failed (exit code ${result.exitCode}). You can retry manually with: npx convex dev --configure new --once`,
        );
        return 1;
      }

      deps.stdout(
        "Project created! Now create a deploy key at https://dashboard.convex.dev → [your project] → Settings → Deploy Keys",
      );

      // Try to read .env.local for CONVEX_DEPLOYMENT
      const doReadEnv = deps.readEnvLocal ?? defaultReadEnvLocal;
      const deployment = await doReadEnv();
      if (deployment) {
        derivedUrl = deriveUrlFromDeployment(deployment);
      }
    }

    // Step 3: Prompt for deploy key with validation loop
    let deployKey: string;
    for (;;) {
      deployKey = await ask(
        "Enter your Convex deploy key (create one at https://dashboard.convex.dev → Settings → Deploy Keys): ",
      );

      if (!deployKey) {
        deps.stderr("Deploy key cannot be empty.");
        continue;
      }

      if (!validateDeployKey(deployKey)) {
        deps.stderr(
          'Invalid deploy key format. Expected "<type>:<name>|<token>" where type is dev, prod, preview, or project.',
        );
        continue;
      }

      break;
    }

    // Step 4: URL — use derived URL or prompt
    let url: string;
    if (derivedUrl) {
      deps.stdout(`Detected Convex URL: ${derivedUrl}`);
      url = derivedUrl;
    } else {
      for (;;) {
        url = await ask(
          "Enter your Convex deployment URL (e.g. https://happy-animal-123.convex.cloud): ",
        );

        if (!url) {
          deps.stderr("URL cannot be empty.");
          continue;
        }

        if (!validateConvexUrlFormat(url)) {
          deps.stderr("Invalid URL format. Expected https://<name>.convex.cloud");
          continue;
        }

        break;
      }
    }

    return await saveAndPush(deployKey, url, deps);
  } finally {
    defaultPrompt?.close();
  }
}
