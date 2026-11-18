import { win32 } from "node:path";

function drivePath(path: string): boolean {
  return (
    /^[a-z]:[/\\]+[^/\\]/i.test(path) &&
    !path.slice(2).includes(":") &&
    !path.includes("\0") &&
    !path.split(/[/\\]/).some((part) => /[. ]$/.test(part))
  );
}

/** Select the standard user Temp using the worker environment. TEMP/TMP may point to shared or system storage. */
export function windowsLocalTempRoot(localAppData: string | undefined, profile: string): string | undefined {
  if (!localAppData || !drivePath(localAppData) || !drivePath(profile)) return undefined;
  const relative = win32.relative(profile, localAppData);

  if (!relative || relative === ".." || relative.startsWith("..\\") || win32.isAbsolute(relative)) return undefined;

  return win32.join(localAppData, "Temp");
}
