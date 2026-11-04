import { findCli } from "../../cli-tools/discovery.ts";

/** Every distribution uses the machine's CLI. Never let the SDK select its optional binary. */
export function claudeExecutable(
  configured?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  // Same lookup as discovery: PATH, then where the official installers put the CLI.
  const executable =
    configured ||
    findCli("claude", env["HOME"] || undefined, undefined, (command) =>
      Bun.which(command, { PATH: env["PATH"] ?? "" }),
    );

  if (!executable) throw new Error("Claude Code is not installed on this computer");

  return executable;
}
