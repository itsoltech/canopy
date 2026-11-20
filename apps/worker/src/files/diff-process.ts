import { spawn } from "node:child_process";
import { governNodeSpawn, killProcessTree, runProcess } from "@canopy/process-governor";
import { DIFF_BYTES, DIFF_METADATA_BYTES } from "@canopy/domain/thread-diff-limits";
import { gitReadArgv, gitReadEnv, gitReadFilters } from "../git/read-policy.ts";

export const DIFF_TTL = 5 * 60_000;

export class DiffLimit extends Error {}

export interface DiffBudget {
  bytes: number;
  signal: AbortSignal;
  gitConfig?: readonly string[];
}

export function diffBytes(budget: DiffBudget, length: number) {
  budget.signal.throwIfAborted();
  budget.bytes += length;

  if (budget.bytes > DIFF_BYTES) throw new DiffLimit();
}

const argv = (args: string[], config: readonly string[]) =>
  gitReadArgv(args, ["-c", "diff.suppressBlankEmpty=false", ...config]);

export const diffGitConfig = gitReadFilters;

export async function diffGit(root: string, args: string[], budget: DiffBudget) {
  if (!budget.gitConfig) throw new Error("Git settings unavailable.");

  return runProcess(
    {
      argv: argv(args, budget.gitConfig),
      cwd: root,
      env: gitReadEnv(),
      signal: budget.signal,
      timeoutMs: 30_000,
      maxBytes: 4 * DIFF_METADATA_BYTES,
    },
    { kind: "git" },
  );
}

/** Backpressure comes from the stream iterator; output is never retained in a process capture. */
export async function streamDiffGit(
  root: string,
  args: string[],
  budget: DiffBudget,
  consume: (chunk: Buffer) => void,
): Promise<number | null> {
  budget.signal.throwIfAborted();

  if (!budget.gitConfig) throw new Error("Git settings unavailable.");
  const command = argv(args, budget.gitConfig);

  const child = governNodeSpawn("git", () =>
    spawn(command[0]!, command.slice(1), {
      cwd: root,
      env: gitReadEnv(),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );

  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", () => reject(new Error("Could not read changes.")));
    child.once("close", resolve);
  });

  const stop = () => {
    if (child.pid) void killProcessTree(child.pid);
  };

  budget.signal.addEventListener("abort", stop, { once: true });

  try {
    for await (const chunk of child.stdout) {
      diffBytes(budget, chunk.length);
      consume(chunk);
    }

    budget.signal.throwIfAborted();

    return await exited;
  } catch (cause) {
    stop();
    await exited.catch(() => {});
    throw cause;
  } finally {
    budget.signal.removeEventListener("abort", stop);
  }
}
