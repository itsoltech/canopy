import { homedir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import type { LogSource } from "./limits.ts";
import { Logs } from "./writer.ts";

export function runtimeLogDirectory(source: LogSource, env: NodeJS.ProcessEnv = process.env) {
  return (
    env["CANOPY_LOG_DIR"] || join(env["XDG_STATE_HOME"] || join(homedir(), ".local", "state"), "canopy", source, "logs")
  );
}

/** Desktop supervisors capture child stdout instead. Standalone processes own exactly one writer. */
export function installLogWriter(source: LogSource, directory: string, secrets: string[] = []) {
  if (process.env["CANOPY_LOG_SUPERVISED"] === "1") return;
  const logs = new Logs(directory);
  logs.protect(...secrets);

  for (const level of ["info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: Parameters<typeof console.info>) => {
      try {
        logs.stream(source)(format(...args) + "\n");
      } catch {
        /* A full log disk must not interrupt runtime work. Export reports unavailable sources. */
      }

      original(...args);
    };
  }
}

export function registeredLogs(directory: string, sources: readonly LogSource[]) {
  return sources.map((source) => ({ source, file: join(directory, `${source}.log`), rotationVerified: true }));
}
