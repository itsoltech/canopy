import { spawn } from "node:child_process";
import { governNodeSpawn, windowsCommand, startWorkload } from "@canopy/process-governor";
import type { AcpOptions } from "./index.ts";

export function spawnAgent(options: AcpOptions) {
  const command = windowsCommand([options.executable, ...options.args], options.env, process.platform, options.cwd);

  return governNodeSpawn("harness", () =>
    startWorkload(command.argv, (argv) =>
      spawn(argv[0]!, argv.slice(1), {
        ...(options.cwd && { cwd: options.cwd }),
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsVerbatimArguments: command.windowsVerbatimArguments,
      }),
    ),
  );
}
