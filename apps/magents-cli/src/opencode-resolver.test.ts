import { describe, expect, it } from "bun:test";
import {
  resolveOpencodePath,
  setOpencodePath,
  getOpencodeVersion,
  detectOpencodePath,
  type OpencodeResolverDeps,
} from "./opencode-resolver";
import type { MagentsGlobalConfig } from "./global-config";
import { OrchestrationError } from "./types";

function createMockDeps(
  overrides: Partial<OpencodeResolverDeps> = {},
): OpencodeResolverDeps {
  let storedConfig: MagentsGlobalConfig = {};
  return {
    exec: async () => ({ stdout: "", stderr: "" }),
    readConfig: async () => storedConfig,
    writeConfig: async (config) => {
      storedConfig = config;
    },
    ...overrides,
  };
}

/**
 * Helper: creates an exec mock that handles `which`, `--version`, and `--help`.
 */
function createExecMock(opts: {
  whichResult?: string;
  version?: string;
  helpOutput?: string;
  whichError?: boolean;
  versionError?: boolean;
  helpError?: boolean;
}) {
  return async (cmd: string) => {
    if (cmd === "which opencode") {
      if (opts.whichError) throw new Error("command not found");
      return { stdout: opts.whichResult ?? "/usr/local/bin/opencode\n", stderr: "" };
    }
    if (cmd.endsWith("--version")) {
      if (opts.versionError) throw new Error("command failed");
      return { stdout: opts.version ?? "1.2.14\n", stderr: "" };
    }
    if (cmd.endsWith("--help")) {
      if (opts.helpError) throw new Error("command failed");
      return { stdout: opts.helpOutput ?? "\x1b[1mUsage: opencode [options]\x1b[0m\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

describe("getOpencodeVersion", () => {
  it("returns trimmed version string", async () => {
    const deps = createMockDeps({
      exec: async () => ({ stdout: "1.2.14\n", stderr: "" }),
    });
    const version = await getOpencodeVersion("/usr/local/bin/opencode", deps);
    expect(version).toBe("1.2.14");
  });

  it("parses version with extra whitespace", async () => {
    const deps = createMockDeps({
      exec: async () => ({ stdout: "  0.5.3  \n", stderr: "" }),
    });
    const version = await getOpencodeVersion("/usr/bin/opencode", deps);
    expect(version).toBe("0.5.3");
  });

  it("throws if --version returns empty output", async () => {
    const deps = createMockDeps({
      exec: async () => ({ stdout: "  \n", stderr: "" }),
    });
    await expect(getOpencodeVersion("/bin/opencode", deps)).rejects.toThrow(
      OrchestrationError,
    );
  });

  it("throws if exec fails", async () => {
    const deps = createMockDeps({
      exec: async () => { throw new Error("ENOENT"); },
    });
    await expect(getOpencodeVersion("/bad/path", deps)).rejects.toThrow(
      OrchestrationError,
    );
  });
});

describe("detectOpencodePath", () => {
  it("returns path when which succeeds", async () => {
    const deps = createMockDeps({
      exec: async () => ({ stdout: "/usr/local/bin/opencode\n", stderr: "" }),
    });
    const result = await detectOpencodePath(deps);
    expect(result).toBe("/usr/local/bin/opencode");
  });

  it("returns null when which fails", async () => {
    const deps = createMockDeps({
      exec: async () => { throw new Error("not found"); },
    });
    const result = await detectOpencodePath(deps);
    expect(result).toBeNull();
  });

  it("returns null when which returns empty output", async () => {
    const deps = createMockDeps({
      exec: async () => ({ stdout: "  \n", stderr: "" }),
    });
    const result = await detectOpencodePath(deps);
    expect(result).toBeNull();
  });
});

describe("resolveOpencodePath", () => {
  it("auto-detects when which returns a path", async () => {
    const exec = createExecMock({ whichResult: "/usr/local/bin/opencode\n" });
    const deps = createMockDeps({ exec });

    const result = await resolveOpencodePath(deps);
    expect(result.path).toBe("/usr/local/bin/opencode");
    expect(result.version).toBe("1.2.14");
    expect(result.source).toBe("auto-detected");
  });

  it("throws OPENCODE_NOT_FOUND when which fails and no config", async () => {
    const exec = createExecMock({ whichError: true });
    const deps = createMockDeps({ exec });

    try {
      await resolveOpencodePath(deps);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
      expect((err as OrchestrationError).code).toBe("OPENCODE_NOT_FOUND");
    }
  });

  it("uses config path over auto-detection", async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd.endsWith("--version")) return { stdout: "2.0.0\n", stderr: "" };
      if (cmd.endsWith("--help")) return { stdout: "Usage: opencode\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const deps = createMockDeps({
      exec,
      readConfig: async () => ({ opencodePath: "/custom/opencode" }),
    });

    const result = await resolveOpencodePath(deps);
    expect(result.path).toBe("/custom/opencode");
    expect(result.version).toBe("2.0.0");
    expect(result.source).toBe("config");
    // Should NOT have called `which opencode` since config had a path
    expect(execCalls).not.toContain("which opencode");
  });

  it("throws OPENCODE_VALIDATION_FAILED if --version fails", async () => {
    const exec = createExecMock({
      whichResult: "/usr/local/bin/opencode\n",
      versionError: true,
    });
    const deps = createMockDeps({ exec });

    try {
      await resolveOpencodePath(deps);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
      expect((err as OrchestrationError).code).toBe("OPENCODE_VALIDATION_FAILED");
    }
  });

  it("throws OPENCODE_VALIDATION_FAILED if --help fails", async () => {
    const exec = createExecMock({
      whichResult: "/usr/local/bin/opencode\n",
      helpError: true,
    });
    const deps = createMockDeps({ exec });

    try {
      await resolveOpencodePath(deps);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
      expect((err as OrchestrationError).code).toBe("OPENCODE_VALIDATION_FAILED");
    }
  });
});

describe("setOpencodePath", () => {
  it("validates and persists the path", async () => {
    let savedConfig: MagentsGlobalConfig = {};
    const exec = createExecMock({});
    const deps = createMockDeps({
      exec,
      writeConfig: async (config) => {
        savedConfig = config;
      },
    });

    const result = await setOpencodePath("/opt/opencode/bin/opencode", deps);
    expect(result.path).toBe("/opt/opencode/bin/opencode");
    expect(result.version).toBe("1.2.14");
    expect(savedConfig.opencodePath).toBe("/opt/opencode/bin/opencode");
  });

  it("throws if validation fails before persisting", async () => {
    let writeConfigCalled = false;
    const exec = createExecMock({ versionError: true });
    const deps = createMockDeps({
      exec,
      writeConfig: async () => {
        writeConfigCalled = true;
      },
    });

    await expect(
      setOpencodePath("/bad/opencode", deps),
    ).rejects.toThrow(OrchestrationError);
    expect(writeConfigCalled).toBe(false);
  });

  it("preserves existing config fields when persisting", async () => {
    let savedConfig: MagentsGlobalConfig = {};
    const exec = createExecMock({});
    const deps = createMockDeps({
      exec,
      readConfig: async () => ({
        convexDeployKey: "dev:test|token",
        convexUrl: "https://test.convex.cloud",
      }),
      writeConfig: async (config) => {
        savedConfig = config;
      },
    });

    await setOpencodePath("/usr/local/bin/opencode", deps);
    expect(savedConfig.convexDeployKey).toBe("dev:test|token");
    expect(savedConfig.convexUrl).toBe("https://test.convex.cloud");
    expect(savedConfig.opencodePath).toBe("/usr/local/bin/opencode");
  });
});
