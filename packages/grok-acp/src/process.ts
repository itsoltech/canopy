import { spawn } from "node:child_process";
import { governNodeSpawn } from "@canopy/process-governor";
import type { GrokOptions } from "./index.ts";

export function spawnGrok(options: GrokOptions) {
  return governNodeSpawn("harness", () =>
    spawn(options.executable ?? "grok", [...(options.args ?? ["agent", "--no-leader", "stdio"])], {
      ...(options.cwd && { cwd: options.cwd }),
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    }),
  );
}
