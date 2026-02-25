import { describe, expect, it } from "bun:test";
import * as path from "node:path";

import { handleLink, type LinkDeps } from "./link";

function createMockDeps(overrides: Partial<LinkDeps> = {}): LinkDeps {
  return {
    exec: async () => ({ stdout: "/repo\n", stderr: "" }),
    readFile: async () => { throw new Error("ENOENT"); },
    writeFile: async () => {},
    readdir: async () => [],
    stat: async () => ({ isDirectory: () => true }),
    prompt: async () => "",
    log: () => {},
    cwd: "/repo",
    ...overrides,
  };
}

function createMockPrompt(responses: string[]) {
  let callIndex = 0;
  return async (_question: string): Promise<string> => {
    return responses[callIndex++] ?? "";
  };
}

describe("handleLink — git repo detection", () => {
  it("errors if not inside a git repo", async () => {
    const logs: string[] = [];
    const deps = createMockDeps({
      exec: async () => { throw new Error("fatal: not a git repository"); },
      log: (...args) => logs.push(args.join(" ")),
    });

    const code = await handleLink([], deps);

    expect(code).toBe(1);
    expect(logs[0]).toContain("Not inside a git repository");
  });

  it("succeeds when inside a git repo", async () => {
    const logs: string[] = [];
    const deps = createMockDeps({
      log: (...args) => logs.push(args.join(" ")),
      prompt: createMockPrompt(["apps/my-app"]),
      readFile: async (filePath: string) => {
        if (filePath === path.join("/repo", "apps/my-app", "app.json")) {
          return JSON.stringify({ expo: { name: "my-app" } });
        }
        throw new Error("ENOENT");
      },
    });

    const code = await handleLink([], deps);

    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("Linked!"))).toBe(true);
  });
});

describe("handleLink — auto-detection", () => {
  function createFsDeps(
    structure: Record<string, any>,
    overrides: Partial<LinkDeps> = {},
  ): LinkDeps {
    return createMockDeps({
      readdir: async (dir: string, opts?: any) => {
        const entries = structure[dir];
        if (!entries) return [];
        return entries.map((e: any) => ({
          name: e.name,
          isDirectory: () => e.isDir,
        }));
      },
      readFile: async (filePath: string) => {
        const content = structure[`file:${filePath}`];
        if (content !== undefined) return content;
        throw new Error("ENOENT");
      },
      ...overrides,
    });
  }

  it("detects a single Expo app and confirms", async () => {
    const logs: string[] = [];
    let writtenPath = "";
    let writtenContent = "";

    const structure: Record<string, any> = {
      "/repo": [{ name: "apps", isDir: true }],
      "/repo/apps": [{ name: "my-app", isDir: true }],
      "/repo/apps/my-app": [{ name: "app.json", isDir: false }],
      "file:/repo/apps/my-app/app.json": JSON.stringify({ expo: { name: "my-app" } }),
    };

    const deps = createFsDeps(structure, {
      log: (...args) => logs.push(args.join(" ")),
      prompt: createMockPrompt(["yes"]),
      writeFile: async (p, c) => { writtenPath = p; writtenContent = c; },
    });

    const code = await handleLink([], deps);

    expect(code).toBe(0);
    expect(writtenPath).toBe(path.join("/repo", "magents.json"));
    const parsed = JSON.parse(writtenContent);
    expect(parsed.expoAppDir).toBe(path.join("apps", "my-app"));
    expect(parsed.version).toBe(1);
    expect(logs.some((l) => l.includes("Linked!"))).toBe(true);
  });

  it("detects a single Expo app and user declines, enters manual path", async () => {
    const logs: string[] = [];

    const structure: Record<string, any> = {
      "/repo": [{ name: "apps", isDir: true }],
      "/repo/apps": [{ name: "my-app", isDir: true }],
      "/repo/apps/my-app": [{ name: "app.json", isDir: false }],
      "file:/repo/apps/my-app/app.json": JSON.stringify({ expo: { name: "my-app" } }),
    };

    const deps = createFsDeps(structure, {
      log: (...args) => logs.push(args.join(" ")),
      prompt: createMockPrompt(["no", "apps/my-app"]),
      writeFile: async () => {},
    });

    const code = await handleLink([], deps);

    expect(code).toBe(0);
  });

  it("detects multiple Expo apps and lets user select", async () => {
    const logs: string[] = [];
    let writtenContent = "";

    const structure: Record<string, any> = {
      "/repo": [{ name: "apps", isDir: true }],
      "/repo/apps": [
        { name: "app-a", isDir: true },
        { name: "app-b", isDir: true },
      ],
      "/repo/apps/app-a": [{ name: "app.json", isDir: false }],
      "/repo/apps/app-b": [{ name: "app.json", isDir: false }],
      "file:/repo/apps/app-a/app.json": JSON.stringify({ expo: { name: "a" } }),
      "file:/repo/apps/app-b/app.json": JSON.stringify({ expo: { name: "b" } }),
    };

    const deps = createFsDeps(structure, {
      log: (...args) => logs.push(args.join(" ")),
      prompt: createMockPrompt(["2"]),
      writeFile: async (_p, c) => { writtenContent = c; },
    });

    const code = await handleLink([], deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(writtenContent);
    expect(parsed.expoAppDir).toBe(path.join("apps", "app-b"));
  });

  it("returns error for invalid selection with multiple apps", async () => {
    const logs: string[] = [];

    const structure: Record<string, any> = {
      "/repo": [{ name: "apps", isDir: true }],
      "/repo/apps": [
        { name: "app-a", isDir: true },
        { name: "app-b", isDir: true },
      ],
      "/repo/apps/app-a": [{ name: "app.json", isDir: false }],
      "/repo/apps/app-b": [{ name: "app.json", isDir: false }],
      "file:/repo/apps/app-a/app.json": JSON.stringify({ expo: { name: "a" } }),
      "file:/repo/apps/app-b/app.json": JSON.stringify({ expo: { name: "b" } }),
    };

    const deps = createFsDeps(structure, {
      log: (...args) => logs.push(args.join(" ")),
      prompt: createMockPrompt(["99"]),
    });

    const code = await handleLink([], deps);

    expect(code).toBe(1);
    expect(logs.some((l) => l.includes("Invalid selection"))).toBe(true);
  });

  it("prompts for manual path when no Expo apps detected", async () => {
    const logs: string[] = [];
    const questions: string[] = [];
    let writtenContent = "";

    const structure: Record<string, any> = {
      "/repo": [],
    };

    const deps = createFsDeps(structure, {
      log: (...args) => logs.push(args.join(" ")),
      prompt: async (q) => {
        questions.push(q);
        return "custom/app";
      },
      readFile: async (filePath: string) => {
        if (filePath === path.join("/repo", "custom/app", "app.json")) {
          return JSON.stringify({ expo: { name: "custom" } });
        }
        throw new Error("ENOENT");
      },
      writeFile: async (_p, c) => { writtenContent = c; },
    });

    const code = await handleLink([], deps);

    expect(code).toBe(0);
    expect(questions[0]).toContain("No Expo app detected");
    const parsed = JSON.parse(writtenContent);
    expect(parsed.expoAppDir).toBe(path.join("custom", "app"));
  });

  it("skips node_modules and .git directories during scan", async () => {
    const scannedDirs: string[] = [];

    const structure: Record<string, any> = {
      "/repo": [
        { name: "node_modules", isDir: true },
        { name: ".git", isDir: true },
        { name: "build", isDir: true },
        { name: "dist", isDir: true },
        { name: "src", isDir: true },
      ],
      "/repo/src": [{ name: "app.json", isDir: false }],
      "file:/repo/src/app.json": JSON.stringify({ expo: { name: "src" } }),
    };

    const deps = createMockDeps({
      readdir: async (dir: string) => {
        scannedDirs.push(dir);
        const entries = structure[dir];
        if (!entries) return [];
        return entries.map((e: any) => ({
          name: e.name,
          isDirectory: () => e.isDir,
        }));
      },
      readFile: async (filePath: string) => {
        const content = structure[`file:${filePath}`];
        if (content !== undefined) return content;
        throw new Error("ENOENT");
      },
      log: () => {},
      prompt: createMockPrompt(["yes"]),
      writeFile: async () => {},
    });

    await handleLink([], deps);

    // node_modules, .git, build, dist should NOT be scanned
    expect(scannedDirs).not.toContain("/repo/node_modules");
    expect(scannedDirs).not.toContain("/repo/.git");
    expect(scannedDirs).not.toContain("/repo/build");
    expect(scannedDirs).not.toContain("/repo/dist");
    // src should be scanned
    expect(scannedDirs).toContain("/repo/src");
  });
});

describe("handleLink — --app-dir flag", () => {
  it("links with valid --app-dir path", async () => {
    const logs: string[] = [];
    let writtenPath = "";
    let writtenContent = "";

    const deps = createMockDeps({
      log: (...args) => logs.push(args.join(" ")),
      readFile: async (filePath: string) => {
        if (filePath === path.join("/repo", "apps/my-app", "app.json")) {
          return JSON.stringify({ expo: { name: "my-app" } });
        }
        throw new Error("ENOENT");
      },
      writeFile: async (p, c) => { writtenPath = p; writtenContent = c; },
    });

    const code = await handleLink(["--app-dir", "apps/my-app"], deps);

    expect(code).toBe(0);
    expect(writtenPath).toBe(path.join("/repo", "magents.json"));
    const parsed = JSON.parse(writtenContent);
    expect(parsed.expoAppDir).toBe(path.join("apps", "my-app"));
    expect(parsed.version).toBe(1);
    expect(logs.some((l) => l.includes("Linked!"))).toBe(true);
  });

  it("errors with invalid --app-dir path (no app.json)", async () => {
    const logs: string[] = [];

    const deps = createMockDeps({
      log: (...args) => logs.push(args.join(" ")),
      readFile: async () => { throw new Error("ENOENT"); },
    });

    const code = await handleLink(["--app-dir", "nonexistent"], deps);

    expect(code).toBe(1);
    expect(logs.some((l) => l.includes("Invalid path"))).toBe(true);
  });

  it("errors with --app-dir pointing to app.json without expo key", async () => {
    const logs: string[] = [];

    const deps = createMockDeps({
      log: (...args) => logs.push(args.join(" ")),
      readFile: async (filePath: string) => {
        if (filePath === path.join("/repo", "some-dir", "app.json")) {
          return JSON.stringify({ name: "not-expo" });
        }
        throw new Error("ENOENT");
      },
    });

    const code = await handleLink(["--app-dir", "some-dir"], deps);

    expect(code).toBe(1);
    expect(logs.some((l) => l.includes("does not contain an app.json with an \"expo\" key"))).toBe(true);
  });

  it("--app-dir overwrites existing magents.json silently", async () => {
    let writeCount = 0;

    const deps = createMockDeps({
      log: () => {},
      readFile: async (filePath: string) => {
        if (filePath === path.join("/repo", "apps/my-app", "app.json")) {
          return JSON.stringify({ expo: { name: "my-app" } });
        }
        if (filePath === path.join("/repo", "magents.json")) {
          return JSON.stringify({ expoAppDir: "old", version: 1 });
        }
        throw new Error("ENOENT");
      },
      writeFile: async () => { writeCount++; },
      prompt: async () => { throw new Error("prompt should not be called for --app-dir"); },
    });

    const code = await handleLink(["--app-dir", "apps/my-app"], deps);

    expect(code).toBe(0);
    expect(writeCount).toBe(1);
  });
});

describe("handleLink — --status flag", () => {
  it("shows existing magents.json contents", async () => {
    const logs: string[] = [];
    const magentsContent = JSON.stringify({ expoAppDir: "apps/my-app", version: 1 }, null, 2);

    const deps = createMockDeps({
      log: (...args) => logs.push(args.join(" ")),
      readFile: async (filePath: string) => {
        if (filePath === path.join("/repo", "magents.json")) {
          return magentsContent;
        }
        throw new Error("ENOENT");
      },
    });

    const code = await handleLink(["--status"], deps);

    expect(code).toBe(0);
    expect(logs[0]).toBe(magentsContent);
  });

  it("errors when magents.json does not exist", async () => {
    const logs: string[] = [];

    const deps = createMockDeps({
      log: (...args) => logs.push(args.join(" ")),
      readFile: async () => { throw new Error("ENOENT"); },
    });

    const code = await handleLink(["--status"], deps);

    expect(code).toBe(1);
    expect(logs[0]).toContain("No magents.json found");
  });
});

describe("handleLink — smart path computation", () => {
  it("stores '.' when Expo app is at repo root", async () => {
    let writtenContent = "";

    const deps = createMockDeps({
      log: () => {},
      readFile: async (filePath: string) => {
        if (filePath === path.join("/repo", "app.json")) {
          return JSON.stringify({ expo: { name: "root-app" } });
        }
        throw new Error("ENOENT");
      },
      writeFile: async (_p, c) => { writtenContent = c; },
    });

    const code = await handleLink(["--app-dir", "."], deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(writtenContent);
    expect(parsed.expoAppDir).toBe(".");
  });

  it("stores relative path for nested Expo app", async () => {
    let writtenContent = "";

    const deps = createMockDeps({
      log: () => {},
      readFile: async (filePath: string) => {
        if (filePath === path.join("/repo", "packages/mobile", "app.json")) {
          return JSON.stringify({ expo: { name: "mobile" } });
        }
        throw new Error("ENOENT");
      },
      writeFile: async (_p, c) => { writtenContent = c; },
    });

    const code = await handleLink(["--app-dir", "packages/mobile"], deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(writtenContent);
    expect(parsed.expoAppDir).toBe(path.join("packages", "mobile"));
  });
});

describe("handleLink — overwrite prompt", () => {
  it("prompts to overwrite when magents.json exists interactively", async () => {
    const logs: string[] = [];
    const questions: string[] = [];
    let writeCount = 0;

    const deps = createMockDeps({
      log: (...args) => logs.push(args.join(" ")),
      readdir: async (dir: string) => {
        if (dir === "/repo") {
          return [{ name: "app.json", isDirectory: () => false }];
        }
        return [];
      },
      readFile: async (filePath: string) => {
        if (filePath === path.join("/repo", "app.json")) {
          return JSON.stringify({ expo: { name: "root" } });
        }
        if (filePath === path.join("/repo", "magents.json")) {
          return JSON.stringify({ expoAppDir: "old", version: 1 });
        }
        throw new Error("ENOENT");
      },
      prompt: async (q) => {
        questions.push(q);
        if (q.includes("Use this?")) return "yes";
        if (q.includes("Overwrite?")) return "yes";
        return "";
      },
      writeFile: async () => { writeCount++; },
    });

    const code = await handleLink([], deps);

    expect(code).toBe(0);
    expect(questions.some((q) => q.includes("Overwrite?"))).toBe(true);
    expect(writeCount).toBe(1);
  });

  it("aborts when user declines overwrite", async () => {
    const logs: string[] = [];
    let writeCount = 0;

    const deps = createMockDeps({
      log: (...args) => logs.push(args.join(" ")),
      readdir: async (dir: string) => {
        if (dir === "/repo") {
          return [{ name: "app.json", isDirectory: () => false }];
        }
        return [];
      },
      readFile: async (filePath: string) => {
        if (filePath === path.join("/repo", "app.json")) {
          return JSON.stringify({ expo: { name: "root" } });
        }
        if (filePath === path.join("/repo", "magents.json")) {
          return JSON.stringify({ expoAppDir: "old", version: 1 });
        }
        throw new Error("ENOENT");
      },
      prompt: async (q) => {
        if (q.includes("Use this?")) return "yes";
        if (q.includes("Overwrite?")) return "no";
        return "";
      },
      writeFile: async () => { writeCount++; },
    });

    const code = await handleLink([], deps);

    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("Aborted"))).toBe(true);
    expect(writeCount).toBe(0);
  });
});

describe("handleLink — invalid app.json", () => {
  it("rejects app.json without expo key during validation", async () => {
    const logs: string[] = [];

    const deps = createMockDeps({
      log: (...args) => logs.push(args.join(" ")),
      readdir: async () => [],
      readFile: async (filePath: string) => {
        if (filePath === path.join("/repo", "some-dir", "app.json")) {
          return JSON.stringify({ name: "no-expo-key", version: "1.0.0" });
        }
        throw new Error("ENOENT");
      },
      prompt: createMockPrompt(["some-dir"]),
    });

    const code = await handleLink([], deps);

    expect(code).toBe(1);
    expect(logs.some((l) => l.includes("does not contain an app.json with an \"expo\" key"))).toBe(true);
  });

  it("skips app.json with invalid JSON during auto-detection", async () => {
    const logs: string[] = [];
    const questions: string[] = [];

    const deps = createMockDeps({
      log: (...args) => logs.push(args.join(" ")),
      readdir: async (dir: string) => {
        if (dir === "/repo") {
          return [{ name: "app.json", isDirectory: () => false }];
        }
        return [];
      },
      readFile: async (filePath: string) => {
        if (filePath === path.join("/repo", "app.json")) {
          return "{ invalid json }}}";
        }
        throw new Error("ENOENT");
      },
      prompt: async (q) => {
        questions.push(q);
        return "some-dir"; // will fail validation but confirms no detection
      },
    });

    const code = await handleLink([], deps);

    // Should reach "no expo app detected" prompt since invalid JSON is skipped
    expect(questions[0]).toContain("No Expo app detected");
  });
});
