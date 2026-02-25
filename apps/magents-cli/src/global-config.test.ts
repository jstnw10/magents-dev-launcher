import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { getMagentsRoot, readGlobalConfig, writeGlobalConfig } from "./global-config";
import type { MagentsGlobalConfig } from "./global-config";

describe("getMagentsRoot", () => {
  const originalEnv = process.env.MAGENTS_HOME;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MAGENTS_HOME;
    } else {
      process.env.MAGENTS_HOME = originalEnv;
    }
  });

  it("returns default ~/.magents when env var is not set", () => {
    delete process.env.MAGENTS_HOME;
    expect(getMagentsRoot()).toBe(path.join(Bun.env.HOME ?? "/tmp", ".magents"));
  });

  it("respects MAGENTS_HOME env var override", () => {
    process.env.MAGENTS_HOME = "/custom/magents";
    expect(getMagentsRoot()).toBe("/custom/magents");
  });
});

describe("readGlobalConfig", () => {
  let tmpDir: string;
  const originalEnv = process.env.MAGENTS_HOME;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(Bun.env.TMPDIR ?? "/tmp", "global-config-read-"));
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

  it("returns empty object when config file does not exist", async () => {
    const config = await readGlobalConfig();
    expect(config).toEqual({});
  });

  it("reads existing config file", async () => {
    const expected: MagentsGlobalConfig = {
      convexDeployKey: "dev:happy-animal-123|eyJ2...",
      convexUrl: "https://happy-animal-123.convex.cloud",
    };
    await writeFile(path.join(tmpDir, "config.json"), JSON.stringify(expected), "utf-8");

    const config = await readGlobalConfig();
    expect(config).toEqual(expected);
  });

  it("returns empty object for corrupt JSON", async () => {
    await writeFile(path.join(tmpDir, "config.json"), "not valid json{{{", "utf-8");

    const config = await readGlobalConfig();
    expect(config).toEqual({});
  });
});

describe("writeGlobalConfig", () => {
  let tmpDir: string;
  const originalEnv = process.env.MAGENTS_HOME;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(Bun.env.TMPDIR ?? "/tmp", "global-config-write-"));
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

  it("writes config and creates directory if needed", async () => {
    const nestedDir = path.join(tmpDir, "nested", "dir");
    process.env.MAGENTS_HOME = nestedDir;

    const config: MagentsGlobalConfig = {
      convexDeployKey: "dev:test|token",
      convexUrl: "https://test.convex.cloud",
    };
    await writeGlobalConfig(config);

    const raw = await readFile(path.join(nestedDir, "config.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual(config);
  });

  it("overwrites existing config", async () => {
    const first: MagentsGlobalConfig = { convexUrl: "https://first.convex.cloud" };
    const second: MagentsGlobalConfig = { convexUrl: "https://second.convex.cloud" };

    await writeGlobalConfig(first);
    await writeGlobalConfig(second);

    const raw = await readFile(path.join(tmpDir, "config.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual(second);
  });

  it("sets file permissions to 0o600 (owner read/write only)", async () => {
    await writeGlobalConfig({ convexUrl: "https://test.convex.cloud" });

    const info = await stat(path.join(tmpDir, "config.json"));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("roundtrips with readGlobalConfig", async () => {
    const config: MagentsGlobalConfig = {
      convexDeployKey: "dev:roundtrip|key",
      convexUrl: "https://roundtrip.convex.cloud",
    };
    await writeGlobalConfig(config);
    const loaded = await readGlobalConfig();
    expect(loaded).toEqual(config);
  });
});
