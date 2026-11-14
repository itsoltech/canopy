import { homedir } from "node:os";
import { join } from "node:path";
import type { ProfileRuntimeConfig } from "../profiles.ts";
import { instanceShadowHome } from "../../config/homes.ts";

/** CLI auth stays in one durable store, independently of transient ACP configuration. */
export function grokAuthPath(options: {
  dataDir: string;
  id: string;
  runtime: ProfileRuntimeConfig;
  deviceHome?: string | undefined;
  deviceAuthPath?: string | undefined;
}): string {
  const { runtime } = options;

  if (runtime.ownLogin) return join(instanceShadowHome(options.dataDir, "grok", options.id, runtime)!, "auth.json");

  if (runtime.homePath) return join(runtime.homePath, "auth.json");

  return options.deviceAuthPath || join(options.deviceHome || join(homedir(), ".grok"), "auth.json");
}
