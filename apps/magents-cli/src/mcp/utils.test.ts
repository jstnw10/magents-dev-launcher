import { describe, expect, it } from "bun:test";
import { sanitizeId } from "./utils";

describe("sanitizeId", () => {
  it("returns a valid UUID unchanged", () => {
    const id = "019505a0-1234-7abc-8000-abcdef012345";
    expect(sanitizeId(id)).toBe(id);
  });

  it("returns simple string IDs like 'spec'", () => {
    expect(sanitizeId("spec")).toBe("spec");
  });

  it("throws for path traversal with ..", () => {
    expect(() => sanitizeId("../../etc/passwd")).toThrow("Invalid ID");
  });

  it("throws for forward slash", () => {
    expect(() => sanitizeId("foo/bar")).toThrow("Invalid ID");
  });

  it("throws for backslash", () => {
    expect(() => sanitizeId("foo\\bar")).toThrow("Invalid ID");
  });

  it("throws for empty string", () => {
    expect(() => sanitizeId("")).toThrow("Invalid ID");
  });

  it("throws for path traversal embedded in ID", () => {
    expect(() => sanitizeId("note-..hidden")).toThrow("Invalid ID");
  });
});
