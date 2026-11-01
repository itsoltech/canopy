/** Worker OS as reported by the worker (`process.platform`). */
export function osLabel(os: string): string {
  switch (os) {
    case "linux":
      return "Linux";
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    default:
      return os || "unknown OS";
  }
}

/** Path separator on the worker: paths follow the worker's system, not the browser's. */
export const pathSeparator = (os: string): string => (os === "win32" ? "\\" : "/");
