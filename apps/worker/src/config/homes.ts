import { join } from "node:path";
import { homedir } from "node:os";
import type { Harness } from "@canopy/domain/harnesses";

/** Device CLI configuration and fallback credential store used by agy. */
export const defaultAntigravityHome = () => join(homedir(), ".gemini", "antigravity-cli");

/** The durable home of an instance with its own login. */
export function instanceHome(dataDir: string, harness: Harness, id: string): string {
  return join(dataDir, "homes", `${harness}-${id}`);
}

/** A custom login source or own login needs separate configuration and session state. */
export function instanceShadowHome(
  dataDir: string,
  harness: Harness,
  id: string,
  runtime: { readonly shadowHomePath?: string; readonly homePath?: string; readonly ownLogin?: boolean } | undefined,
): string | undefined {
  if (runtime?.shadowHomePath) return runtime.shadowHomePath;

  return runtime?.ownLogin || runtime?.homePath ? instanceHome(dataDir, harness, id) : undefined;
}
