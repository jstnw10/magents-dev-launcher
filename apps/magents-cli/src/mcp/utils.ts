/**
 * Validates that an ID does not contain path traversal sequences or separators.
 * Defense-in-depth: IDs are currently server-generated UUIDs, but this guards
 * against future callers passing user-controlled input.
 */
export function sanitizeId(id: string): string {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(
      `Invalid ID: "${id}" contains path separators or traversal sequences`,
    );
  }
  return id;
}
