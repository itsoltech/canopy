const WINDOWS_LAUNCHER = /\.(?:bat|cmd)$/i;

function quoteCommandPart(value: string): string {
  if (!/[\s"&|<>^]/.test(value)) return value;

  return `"${value.replaceAll(/(["^])/g, "^$1")}"`;
}

/** Run Windows batch launchers through cmd.exe; node spawn cannot execute .cmd/.bat directly. */
export function windowsCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const executable = argv[0];

  if (platform !== "win32" || !executable || !WINDOWS_LAUNCHER.test(executable)) return argv;

  const command = argv.map(quoteCommandPart).join(" ");
  const comspec = env["ComSpec"] || env["COMSPEC"] || "cmd.exe";

  return [comspec, "/d", "/s", "/c", command];
}
