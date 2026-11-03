/** Every distribution uses the machine's CLI. Never let the SDK select its optional binary. */
export function claudeExecutable(configured?: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const executable = configured || Bun.which("claude", { PATH: env["PATH"] ?? "" });
  if (!executable) throw new Error("Claude Code is not installed on this computer");
  return executable;
}
