/** Words of Settings → Import (docs/copy.md): agent CLI names, counts and sizes. */

const KEYS = new Map<string, "CLAUDE" | "CODEX" | "GROK">([
  ["claude", "CLAUDE"],
  ["codex", "CODEX"],
  ["grok", "GROK"],
]);

/** The provider mark of an agent CLI. */
export function providerKey(agentCli: string): "CLAUDE" | "CODEX" | "GROK" {
  return KEYS.get(agentCli) ?? "GROK";
}

export { agentCliName } from "@canopy/domain/import-look";

export function counted(value: number, one: string, many = `${one}s`): string {
  return `${value.toLocaleString("en")} ${value === 1 ? one : many}`;
}

/** Disk sizes up to terabytes, one decimal from megabytes on. */
export function size(bytes: bigint | number): string {
  const value = Number(bytes);
  const units = ["KB", "MB", "GB", "TB"];

  if (value < 1024) return `${value} B`;
  let scaled = value / 1024;
  let unit = 0;

  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }

  return `${scaled.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Where a thread started, as the CLI recorded it. */
export const ORIGINS = new Map([
  ["cli", "Terminal"],
  ["exec", "Script"],
  ["sdk", "SDK app"],
  ["ide", "Editor"],
  ["app", "App"],
  ["unknown", "Unknown"],
]);

/** New threads, and imported ones the CLI added turns to (their thread gets the new turns). */
export function selectable(status: string): boolean {
  return status === "new" || status === "has_new_turns";
}
