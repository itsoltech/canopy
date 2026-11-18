import { closeSync, openSync, readSync } from "node:fs";
import { win32 } from "node:path";

const WINDOWS_LAUNCHER = /\.(?:bat|cmd)$/i;
const CMD_META = /[()[\]%!^"`<>&|;, \t*?]/g;
const NPM_FORWARDING_LINE = /set PATHEXT=[^\r\n]+ & "%_prog%" [^\r\n]+ %\*\r?$/im;
const CMD_INVALID = /[\0\r\n]/;

interface WindowsCommand {
  argv: readonly string[];
  windowsVerbatimArguments: boolean;
}

function escapeCmd(value: string): string {
  return value.replaceAll(CMD_META, "^$&");
}

function quoteArgument(value: string): string {
  if (value && !/[ \t"]/.test(value)) return value;

  // Escape for the receiving executable's Windows argv parser before escaping for cmd.exe.
  const escaped = value.replaceAll(/\\+"?|"/g, (part, offset: number) => {
    if (part.endsWith('"')) return part.slice(0, -1).repeat(2) + '\\"';

    return offset + part.length === value.length ? part.repeat(2) : part;
  });

  return `"${escaped}"`;
}

function isNpmShim(executable: string): boolean {
  let fd: number | undefined;

  try {
    fd = openSync(executable, "r");
    const head = Buffer.alloc(4096);

    return NPM_FORWARDING_LINE.test(head.toString("utf8", 0, readSync(fd, head)));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Run Windows batch launchers through cmd.exe; node spawn cannot execute .cmd/.bat directly. */
export function windowsCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd?: string,
): WindowsCommand {
  const executable = argv[0];

  if (platform !== "win32" || !executable || !WINDOWS_LAUNCHER.test(executable))
    return { argv, windowsVerbatimArguments: false };

  if (executable.includes('"') || argv.some((part) => CMD_INVALID.test(part)))
    throw new Error("Invalid Windows batch launcher or argument.");

  // npm shims forward %* to Node, so the flags must survive a second cmd.exe parse.
  const path = Bun.which(executable, { ...(cwd && { cwd }), PATH: env["PATH"] ?? env["Path"] ?? "" }) ?? executable;
  const npmShim = isNpmShim(win32.resolve(cwd ?? process.cwd(), path));

  const args = argv.slice(1).map((arg) => {
    const escaped = escapeCmd(quoteArgument(arg));

    return npmShim ? escapeCmd(escaped) : escaped;
  });

  const command = [`"${win32.normalize(path)}"`, ...args].join(" ");
  const comspec = env["ComSpec"] || env["COMSPEC"] || "cmd.exe";

  return { argv: [comspec, "/d", "/v:off", "/s", "/c", `"${command}"`], windowsVerbatimArguments: true };
}
