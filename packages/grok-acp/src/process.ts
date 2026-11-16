import { spawn } from "node:child_process";
import { governNodeSpawn, windowsCommand } from "@canopy/process-governor";
import type { GrokOptions } from "./index.ts";

export function spawnGrok(options: GrokOptions) {
  const command = windowsCommand(
    [options.executable ?? "grok", ...(options.args ?? ["agent", "--no-leader", "stdio"])],
    options.env,
  );

  return governNodeSpawn("harness", () =>
    spawn(command[0]!, command.slice(1), {
      ...(options.cwd && { cwd: options.cwd }),
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    }),
  );
}
