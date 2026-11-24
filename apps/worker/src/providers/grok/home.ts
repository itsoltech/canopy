import { homedir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { ProfileRuntimeConfig } from "../profiles.ts";
import { instanceShadowHome } from "../../config/homes.ts";

export function grokProcessHome(root: string, textOnly: boolean) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const sessions = join(root, "sessions");

  if (!textOnly) mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const home = mkdtempSync(join(root, "process-"));

  try {
    if (!textOnly) symlinkSync(sessions, join(home, "sessions"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }

  return { home, sessions };
}

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
