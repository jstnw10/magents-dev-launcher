/**
 * Shared git command runner using Bun.spawn.
 */
export async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  return { stdout: stdout.trimEnd(), exitCode };
}
