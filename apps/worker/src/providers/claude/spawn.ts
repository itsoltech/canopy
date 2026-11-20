import { spawn } from "node:child_process";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { governNodeSpawn, killProcessTree, windowsCommand, startWorkload } from "@canopy/process-governor";

/** SDK launch hook accounts for sessions, catalog lookups and text generation alike. */
export function spawnClaude(options: SpawnOptions): SpawnedProcess {
  options.signal.throwIfAborted();

  const command = windowsCommand([options.command, ...options.args], options.env, process.platform, options.cwd);

  const child = governNodeSpawn("harness", () =>
    startWorkload(command.argv, (argv) =>
      spawn(argv[0]!, argv.slice(1), {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: command.windowsVerbatimArguments,
      }),
    ),
  );

  const stop = () => {
    if (child.pid) void killProcessTree(child.pid);
  };

  options.signal.addEventListener("abort", stop, { once: true });
  child.once("close", () => options.signal.removeEventListener("abort", stop));
  // Custom SDK transports have no stderr channel. Drain without logging private CLI output.
  child.stderr.resume();

  return child;
}
