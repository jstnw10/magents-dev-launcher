import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";

import { readGlobalConfig, writeGlobalConfig } from "./global-config";
import { handleInit, validateDeployKey, redactDeployKey, validateConvexUrlFormat, deriveUrlFromDeployment } from "./init";

describe("validateDeployKey", () => {
  it("accepts valid dev deploy key", () => {
    expect(validateDeployKey("dev:happy-animal-123|eyJhbGciOi.token.here")).toBe(true);
  });

  it("accepts valid prod deploy key", () => {
    expect(validateDeployKey("prod:my-deployment|abc123token")).toBe(true);
  });

  it("accepts valid preview deploy key", () => {
    expect(validateDeployKey("preview:test-deploy|sometoken")).toBe(true);
  });

  it("accepts valid project deploy key", () => {
    expect(validateDeployKey("project:my-project|tokenvalue")).toBe(true);
  });

  it("rejects key without type prefix", () => {
    expect(validateDeployKey("happy-animal-123|token")).toBe(false);
  });

  it("rejects key with unknown type", () => {
    expect(validateDeployKey("staging:name|token")).toBe(false);
  });

  it("rejects key without pipe separator", () => {
    expect(validateDeployKey("dev:nametoken")).toBe(false);
  });

  it("rejects key without name", () => {
    expect(validateDeployKey("dev:|token")).toBe(false);
  });

  it("rejects key without token", () => {
    expect(validateDeployKey("dev:name|")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateDeployKey("")).toBe(false);
  });
});

describe("redactDeployKey", () => {
  it("redacts key longer than 20 characters", () => {
    const key = "dev:happy-animal-123|eyJhbGciOiJIUzI1NiJ9.longtoken";
    const redacted = redactDeployKey(key);
    expect(redacted).toBe("dev:happy-animal-123...");
    expect(redacted).not.toContain("eyJhbGci");
  });

  it("returns short key as-is", () => {
    const key = "dev:a|b";
    expect(redactDeployKey(key)).toBe("dev:a|b");
  });

  it("shows first 20 chars for exactly 21 char key", () => {
    const key = "dev:exactlytwentyone";  // 20 chars
    expect(redactDeployKey(key)).toBe(key); // exactly 20, no redaction
    const key21 = "dev:exactlytwentyone!"; // 21 chars
    expect(redactDeployKey(key21)).toBe("dev:exactlytwentyone...");
  });
});

describe("handleInit --status", () => {
  let tmpDir: string;
  const originalEnv = process.env.MAGENTS_HOME;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(Bun.env.TMPDIR ?? "/tmp", "init-status-"));
    process.env.MAGENTS_HOME = tmpDir;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.MAGENTS_HOME;
    } else {
      process.env.MAGENTS_HOME = originalEnv;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("shows error when no config exists", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const code = await handleInit(["--status"], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors[0]).toContain("No configuration found");
  });

  it("shows config with redacted deploy key", async () => {
    await writeGlobalConfig({
      convexDeployKey: "dev:happy-animal-123|eyJhbGciOiJIUzI1NiJ9.longtoken",
      convexUrl: "https://happy-animal-123.convex.cloud",
    });

    const output: string[] = [];
    const errors: string[] = [];

    const code = await handleInit(["--status"], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    });

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const parsed = JSON.parse(output[0]) as { convexDeployKey: string; convexUrl: string };
    expect(parsed.convexDeployKey).toBe("dev:happy-animal-123...");
    expect(parsed.convexUrl).toBe("https://happy-animal-123.convex.cloud");
  });
});

describe("handleInit --deploy-key --url", () => {
  let tmpDir: string;
  const originalEnv = process.env.MAGENTS_HOME;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(Bun.env.TMPDIR ?? "/tmp", "init-setup-"));
    process.env.MAGENTS_HOME = tmpDir;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.MAGENTS_HOME;
    } else {
      process.env.MAGENTS_HOME = originalEnv;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("saves config on successful init", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const code = await handleInit(
      ["--deploy-key", "dev:my-app|token123", "--url", "https://my-app.convex.cloud"],
      {
        stdout: (line) => output.push(line),
        stderr: (line) => errors.push(line),
        validateUrl: async () => {},
        pushConvex: async () => ({ ok: true }),
      },
    );

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const config = await readGlobalConfig();
    expect(config.convexDeployKey).toBe("dev:my-app|token123");
    expect(config.convexUrl).toBe("https://my-app.convex.cloud");

    // Check output includes success
    expect(output.some((line) => line.includes("Configuration saved"))).toBe(true);
    expect(output.some((line) => line.includes("Convex push succeeded"))).toBe(true);
  });

  it("rejects invalid deploy key format", async () => {
    const noop = () => {};

    expect(
      handleInit(
        ["--deploy-key", "invalid-key", "--url", "https://my-app.convex.cloud"],
        {
          stdout: noop,
          stderr: noop,
          validateUrl: async () => {},
          pushConvex: async () => ({ ok: true }),
        },
      ),
    ).rejects.toThrow("Invalid deploy key format");
  });

  it("requires --deploy-key flag", async () => {
    const noop = () => {};

    expect(
      handleInit(
        ["--url", "https://my-app.convex.cloud"],
        {
          stdout: noop,
          stderr: noop,
          validateUrl: async () => {},
          pushConvex: async () => ({ ok: true }),
        },
      ),
    ).rejects.toThrow("Missing required flag --deploy-key");
  });

  it("requires --url flag", async () => {
    const noop = () => {};

    expect(
      handleInit(
        ["--deploy-key", "dev:my-app|token123"],
        {
          stdout: noop,
          stderr: noop,
          validateUrl: async () => {},
          pushConvex: async () => ({ ok: true }),
        },
      ),
    ).rejects.toThrow("Missing required flag --url");
  });

  it("saves config even when convex push fails", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const code = await handleInit(
      ["--deploy-key", "dev:my-app|token123", "--url", "https://my-app.convex.cloud"],
      {
        stdout: (line) => output.push(line),
        stderr: (line) => errors.push(line),
        validateUrl: async () => {},
        pushConvex: async () => ({ ok: false, error: "Connection timeout" }),
      },
    );

    expect(code).toBe(0);

    // Config should still be saved
    const config = await readGlobalConfig();
    expect(config.convexDeployKey).toBe("dev:my-app|token123");
    expect(config.convexUrl).toBe("https://my-app.convex.cloud");

    // Warning should be printed to stderr
    expect(errors.some((line) => line.includes("Warning: Convex push failed"))).toBe(true);
    expect(errors.some((line) => line.includes("Connection timeout"))).toBe(true);

    // Output should indicate push failed
    const resultLine = output.find((line) => line.includes("convexPush"));
    expect(resultLine).toBeDefined();
    const result = JSON.parse(resultLine!) as { convexPush: string };
    expect(result.convexPush).toBe("failed");
  });

  it("reports error when URL validation fails", async () => {
    const noop = () => {};
    const { OrchestrationError } = await import("./types");

    expect(
      handleInit(
        ["--deploy-key", "dev:my-app|token123", "--url", "https://bad-url.convex.cloud"],
        {
          stdout: noop,
          stderr: noop,
          validateUrl: async () => {
            throw new OrchestrationError("UNREACHABLE_URL", "Could not reach the URL.");
          },
          pushConvex: async () => ({ ok: true }),
        },
      ),
    ).rejects.toThrow("Could not reach the URL");
  });
});

describe("validateConvexUrlFormat", () => {
  it("accepts valid convex cloud URL", () => {
    expect(validateConvexUrlFormat("https://happy-animal-123.convex.cloud")).toBe(true);
  });

  it("accepts URL with trailing slash", () => {
    expect(validateConvexUrlFormat("https://happy-animal-123.convex.cloud/")).toBe(true);
  });

  it("rejects http URL", () => {
    expect(validateConvexUrlFormat("http://happy-animal-123.convex.cloud")).toBe(false);
  });

  it("rejects non-convex URL", () => {
    expect(validateConvexUrlFormat("https://example.com")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateConvexUrlFormat("")).toBe(false);
  });
});

describe("deriveUrlFromDeployment", () => {
  it("derives URL from dev deployment", () => {
    expect(deriveUrlFromDeployment("dev:happy-animal-123")).toBe("https://happy-animal-123.convex.cloud");
  });

  it("derives URL from prod deployment", () => {
    expect(deriveUrlFromDeployment("prod:my-project-456")).toBe("https://my-project-456.convex.cloud");
  });

  it("derives URL from preview deployment", () => {
    expect(deriveUrlFromDeployment("preview:test-789")).toBe("https://test-789.convex.cloud");
  });

  it("derives URL from project deployment", () => {
    expect(deriveUrlFromDeployment("project:some-name")).toBe("https://some-name.convex.cloud");
  });

  it("returns null for invalid format", () => {
    expect(deriveUrlFromDeployment("invalid")).toBeNull();
  });

  it("returns null for unknown type prefix", () => {
    expect(deriveUrlFromDeployment("staging:name")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(deriveUrlFromDeployment("")).toBeNull();
  });
});

describe("handleInit interactive mode", () => {
  let tmpDir: string;
  const originalEnv = process.env.MAGENTS_HOME;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(Bun.env.TMPDIR ?? "/tmp", "init-interactive-"));
    process.env.MAGENTS_HOME = tmpDir;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.MAGENTS_HOME;
    } else {
      process.env.MAGENTS_HOME = originalEnv;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createMockPrompt(responses: string[]) {
    let callIndex = 0;
    return async (_question: string): Promise<string> => {
      const response = responses[callIndex] ?? "";
      callIndex++;
      return response;
    };
  }

  it("starts interactive mode when no flags are provided", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const code = await handleInit([], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
      prompt: createMockPrompt([
        "yes",                          // existing deployment
        "dev:my-app|token123",
        "https://my-app.convex.cloud",
      ]),
      pushConvex: async () => ({ ok: true }),
    });

    expect(code).toBe(0);
    expect(output.some((line) => line.includes("Welcome to Magents setup"))).toBe(true);
    expect(output.some((line) => line.includes("Configuration saved"))).toBe(true);
  });

  it("re-prompts on invalid deploy key then accepts valid one", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const code = await handleInit([], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
      prompt: createMockPrompt([
        "yes",                        // existing deployment
        "bad-key",                    // invalid → re-prompt
        "dev:my-app|token123",        // valid
        "https://my-app.convex.cloud", // valid URL
      ]),
      pushConvex: async () => ({ ok: true }),
    });

    expect(code).toBe(0);
    expect(errors.some((line) => line.includes("Invalid deploy key format"))).toBe(true);

    const config = await readGlobalConfig();
    expect(config.convexDeployKey).toBe("dev:my-app|token123");
    expect(config.convexUrl).toBe("https://my-app.convex.cloud");
  });

  it("re-prompts on empty deploy key", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const code = await handleInit([], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
      prompt: createMockPrompt([
        "yes",                        // existing deployment
        "",                           // empty → re-prompt
        "dev:my-app|token123",        // valid
        "https://my-app.convex.cloud", // valid URL
      ]),
      pushConvex: async () => ({ ok: true }),
    });

    expect(code).toBe(0);
    expect(errors.some((line) => line.includes("Deploy key cannot be empty"))).toBe(true);
  });

  it("re-prompts on invalid URL format then accepts valid one", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const code = await handleInit([], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
      prompt: createMockPrompt([
        "yes",                         // existing deployment
        "dev:my-app|token123",         // valid deploy key
        "not-a-url",                   // invalid URL → re-prompt
        "https://my-app.convex.cloud", // valid URL
      ]),
      pushConvex: async () => ({ ok: true }),
    });

    expect(code).toBe(0);
    expect(errors.some((line) => line.includes("Invalid URL format"))).toBe(true);

    const config = await readGlobalConfig();
    expect(config.convexUrl).toBe("https://my-app.convex.cloud");
  });

  it("re-prompts on empty URL", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const code = await handleInit([], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
      prompt: createMockPrompt([
        "yes",                         // existing deployment
        "dev:my-app|token123",         // valid deploy key
        "",                            // empty → re-prompt
        "https://my-app.convex.cloud", // valid URL
      ]),
      pushConvex: async () => ({ ok: true }),
    });

    expect(code).toBe(0);
    expect(errors.some((line) => line.includes("URL cannot be empty"))).toBe(true);
  });

  it("saves config and runs push after successful interactive flow", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const code = await handleInit([], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
      prompt: createMockPrompt([
        "yes",                          // existing deployment
        "prod:my-deployment|secrettoken",
        "https://my-deployment.convex.cloud",
      ]),
      pushConvex: async () => ({ ok: true }),
    });

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const config = await readGlobalConfig();
    expect(config.convexDeployKey).toBe("prod:my-deployment|secrettoken");
    expect(config.convexUrl).toBe("https://my-deployment.convex.cloud");

    expect(output.some((line) => line.includes("Configuration saved"))).toBe(true);
    expect(output.some((line) => line.includes("Convex push succeeded"))).toBe(true);

    const resultLine = output.find((line) => line.includes("convexPush"));
    expect(resultLine).toBeDefined();
    const result = JSON.parse(resultLine!) as { configured: boolean; convexUrl: string; convexPush: string };
    expect(result.configured).toBe(true);
    expect(result.convexPush).toBe("success");
  });

  it("flags still bypass interactive mode", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const code = await handleInit(
      ["--deploy-key", "dev:my-app|token123", "--url", "https://my-app.convex.cloud"],
      {
        stdout: (line) => output.push(line),
        stderr: (line) => errors.push(line),
        validateUrl: async () => {},
        pushConvex: async () => ({ ok: true }),
        prompt: async () => { throw new Error("prompt should not be called"); },
      },
    );

    expect(code).toBe(0);
    // Should NOT show interactive welcome message
    expect(output.some((line) => line.includes("Welcome to Magents setup"))).toBe(false);
  });

  it("asks about existing deployment first", async () => {
    const questions: string[] = [];
    const output: string[] = [];
    const errors: string[] = [];

    let callIndex = 0;
    const responses = ["yes", "dev:my-app|token123", "https://my-app.convex.cloud"];

    const code = await handleInit([], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
      prompt: async (question: string) => {
        questions.push(question);
        return responses[callIndex++] ?? "";
      },
      pushConvex: async () => ({ ok: true }),
    });

    expect(code).toBe(0);
    expect(questions[0]).toContain("existing Convex deployment");
  });

  it("existing path skips project creation", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    let setupCalled = false;

    const code = await handleInit([], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
      prompt: createMockPrompt([
        "yes",                          // existing deployment
        "dev:my-app|token123",
        "https://my-app.convex.cloud",
      ]),
      pushConvex: async () => ({ ok: true }),
      runConvexSetup: async () => { setupCalled = true; return { exitCode: 0 }; },
    });

    expect(code).toBe(0);
    expect(setupCalled).toBe(false);
    expect(output.some((line) => line.includes("set up a new Convex project"))).toBe(false);
  });

  it("new path calls runConvexSetup and prompts for deploy key", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    let setupCalled = false;

    const code = await handleInit([], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
      prompt: createMockPrompt([
        "no",                            // new project
        "dev:my-app|token123",           // deploy key
        "https://my-app.convex.cloud",   // URL (no .env.local)
      ]),
      pushConvex: async () => ({ ok: true }),
      runConvexSetup: async () => { setupCalled = true; return { exitCode: 0 }; },
      readEnvLocal: async () => null,    // no .env.local
    });

    expect(code).toBe(0);
    expect(setupCalled).toBe(true);
    expect(output.some((line) => line.includes("set up a new Convex project"))).toBe(true);
    expect(output.some((line) => line.includes("Project created"))).toBe(true);
    expect(output.some((line) => line.includes("Configuration saved"))).toBe(true);
  });

  it("new path derives URL from .env.local CONVEX_DEPLOYMENT", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const code = await handleInit([], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
      prompt: createMockPrompt([
        "no",                            // new project
        "dev:my-app|token123",           // deploy key
        // no URL prompt needed — derived from .env.local
      ]),
      pushConvex: async () => ({ ok: true }),
      runConvexSetup: async () => ({ exitCode: 0 }),
      readEnvLocal: async () => "dev:happy-animal-123",
    });

    expect(code).toBe(0);
    expect(output.some((line) => line.includes("Detected Convex URL: https://happy-animal-123.convex.cloud"))).toBe(true);

    const config = await readGlobalConfig();
    expect(config.convexUrl).toBe("https://happy-animal-123.convex.cloud");
  });

  it("new path falls back to URL prompt when .env.local has no deployment", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const code = await handleInit([], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
      prompt: createMockPrompt([
        "no",                            // new project
        "dev:my-app|token123",           // deploy key
        "https://my-app.convex.cloud",   // URL (fallback)
      ]),
      pushConvex: async () => ({ ok: true }),
      runConvexSetup: async () => ({ exitCode: 0 }),
      readEnvLocal: async () => null,
    });

    expect(code).toBe(0);
    expect(output.some((line) => line.includes("Detected Convex URL"))).toBe(false);

    const config = await readGlobalConfig();
    expect(config.convexUrl).toBe("https://my-app.convex.cloud");
  });

  it("new path shows error when project creation fails", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const code = await handleInit([], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
      prompt: createMockPrompt([
        "no",                            // new project
      ]),
      pushConvex: async () => ({ ok: true }),
      runConvexSetup: async () => ({ exitCode: 1 }),
    });

    expect(code).toBe(1);
    expect(errors.some((line) => line.includes("Convex project setup failed"))).toBe(true);
    expect(errors.some((line) => line.includes("npx convex dev --configure new --once"))).toBe(true);
  });

  it("re-prompts on invalid yes/no answer", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const code = await handleInit([], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
      prompt: createMockPrompt([
        "maybe",                         // invalid → re-prompt
        "yes",                           // valid
        "dev:my-app|token123",
        "https://my-app.convex.cloud",
      ]),
      pushConvex: async () => ({ ok: true }),
    });

    expect(code).toBe(0);
    expect(errors.some((line) => line.includes('Please answer "yes" or "no"'))).toBe(true);
  });
});
