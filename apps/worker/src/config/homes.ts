import { join } from "node:path";

/** The durable home of an instance with its own login. */
export function instanceHome(dataDir: string, harness: "claude" | "codex" | "grok", id: string): string {
  return join(dataDir, "homes", `${harness}-${id}`);
}

/** A custom login source or own login needs separate configuration and session state. */
export function instanceShadowHome(
  dataDir: string,
  harness: "claude" | "codex" | "grok",
  id: string,
  runtime: { readonly shadowHomePath?: string; readonly homePath?: string; readonly ownLogin?: boolean } | undefined,
): string | undefined {
  if (runtime?.shadowHomePath) return runtime.shadowHomePath;

  return runtime?.ownLogin || runtime?.homePath ? instanceHome(dataDir, harness, id) : undefined;
}
