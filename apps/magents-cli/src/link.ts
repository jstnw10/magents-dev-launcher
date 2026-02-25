import path from "node:path";
import * as readline from "node:readline";
import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";

export interface LinkDeps {
  exec: (cmd: string) => Promise<{ stdout: string; stderr: string }>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  readdir: (path: string, opts?: any) => Promise<any[]>;
  stat: (path: string) => Promise<{ isDirectory(): boolean }>;
  prompt: (question: string) => Promise<string>;
  log: (...args: any[]) => void;
  cwd: string;
}

const EXCLUDED_DIRS = new Set(["node_modules", ".git", "build", "dist"]);

async function getRepoRoot(deps: LinkDeps): Promise<string | null> {
  try {
    const result = await deps.exec("git rev-parse --show-toplevel");
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function findExpoApps(
  dir: string,
  repoRoot: string,
  deps: LinkDeps,
): Promise<string[]> {
  const results: string[] = [];

  let entries: any[];
  try {
    entries = await deps.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : entry.name;
    const fullPath = path.join(dir, name);

    if (typeof entry !== "string" && entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(name)) {
        const nested = await findExpoApps(fullPath, repoRoot, deps);
        results.push(...nested);
      }
    } else if (name === "app.json") {
      try {
        const content = await deps.readFile(fullPath);
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === "object" && "expo" in parsed) {
          const rel = path.relative(repoRoot, dir);
          results.push(rel === "" ? "." : rel);
        }
      } catch {
        // skip invalid JSON
      }
    }
  }

  return results;
}

async function isValidExpoApp(appDir: string, deps: LinkDeps): Promise<boolean> {
  try {
    const appJsonPath = path.join(appDir, "app.json");
    const content = await deps.readFile(appJsonPath);
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && "expo" in parsed;
  } catch {
    return false;
  }
}

function parseFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

export async function handleLink(args: string[], deps: LinkDeps): Promise<number> {
  const isStatus = args.includes("--status");
  const appDirFlag = parseFlag(args, "--app-dir");

  // Get repo root
  const repoRoot = await getRepoRoot(deps);
  if (!repoRoot) {
    deps.log("Not inside a git repository. Run this command from inside a git repo.");
    return 1;
  }

  const magentsJsonPath = path.join(repoRoot, "magents.json");

  // --status: read and print magents.json
  if (isStatus) {
    try {
      const content = await deps.readFile(magentsJsonPath);
      deps.log(content);
      return 0;
    } catch {
      deps.log("No magents.json found. Run `magents link` to create one.");
      return 1;
    }
  }

  // Non-interactive: --app-dir <path>
  if (appDirFlag !== undefined) {
    const absDir = path.resolve(repoRoot, appDirFlag);

    if (!(await isValidExpoApp(absDir, deps))) {
      deps.log(
        `Invalid path: "${appDirFlag}" does not contain an app.json with an "expo" key.`,
      );
      return 1;
    }

    const expoAppDir = path.relative(repoRoot, absDir) || ".";

    await deps.writeFile(
      magentsJsonPath,
      JSON.stringify({ expoAppDir, version: 1 }, null, 2) + "\n",
    );

    deps.log(
      `Linked! magents.json created at ${magentsJsonPath}\n  Expo app: ${expoAppDir}`,
    );
    return 0;
  }

  // Interactive: auto-detect expo apps
  const detected = await findExpoApps(repoRoot, repoRoot, deps);
  let chosenPath: string;

  if (detected.length === 1) {
    const answer = await deps.prompt(
      `Detected Expo app at \`${detected[0]}\`. Use this? (yes/no): `,
    );
    if (answer.toLowerCase() === "yes") {
      chosenPath = detected[0];
    } else {
      chosenPath = await deps.prompt(
        "Enter the path to your Expo app relative to the repo root: ",
      );
    }
  } else if (detected.length > 1) {
    const lines = detected.map((p, i) => `  ${i + 1}. ${p}`).join("\n");
    const answer = await deps.prompt(
      `Found multiple Expo apps:\n${lines}\nSelect (1-${detected.length}): `,
    );
    const index = Number.parseInt(answer, 10) - 1;
    if (Number.isNaN(index) || index < 0 || index >= detected.length) {
      deps.log("Invalid selection.");
      return 1;
    }
    chosenPath = detected[index];
  } else {
    chosenPath = await deps.prompt(
      "No Expo app detected. Enter the path to your Expo app relative to the repo root: ",
    );
  }

  // Validate the chosen path
  const absChosen = path.resolve(repoRoot, chosenPath);
  if (!(await isValidExpoApp(absChosen, deps))) {
    deps.log(
      `Invalid path: "${chosenPath}" does not contain an app.json with an "expo" key.`,
    );
    return 1;
  }

  const expoAppDir = path.relative(repoRoot, absChosen) || ".";

  // Check for existing magents.json
  try {
    await deps.readFile(magentsJsonPath);
    // File exists — ask to overwrite
    const overwrite = await deps.prompt(
      "magents.json already exists. Overwrite? (yes/no): ",
    );
    if (overwrite.toLowerCase() !== "yes") {
      deps.log("Aborted.");
      return 0;
    }
  } catch {
    // File doesn't exist — proceed
  }

  await deps.writeFile(
    magentsJsonPath,
    JSON.stringify({ expoAppDir, version: 1 }, null, 2) + "\n",
  );

  deps.log(
    `Linked! magents.json created at ${magentsJsonPath}\n  Expo app: ${expoAppDir}`,
  );
  return 0;
}

export function createDefaultLinkDeps(): LinkDeps {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return {
    exec: async (cmd: string) => {
      const result = Bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
      if (!result.success) throw new Error(result.stderr.toString());
      return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    },
    readFile: (filePath: string) => Bun.file(filePath).text(),
    writeFile: (filePath: string, content: string) => Bun.write(filePath, content).then(() => {}),
    readdir: (dirPath: string, opts?: any) => fsReaddir(dirPath, opts),
    stat: (filePath: string) => fsStat(filePath),
    prompt: (question: string) =>
      new Promise((resolve) => {
        rl.question(question, (answer: string) => {
          resolve(answer.trim());
        });
      }),
    log: (...args: any[]) => {
      console.log(...args);
    },
    cwd: process.cwd(),
  };
}
