import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { processGovernor, type ProcessKind, type ProcessPolicy } from "./governor.ts";
import type { ChildProcess } from "node:child_process";

export * from "./governor.ts";

export function governBunSpawn<T extends { exited: Promise<number> }>(kind: ProcessKind, start: () => T): T {
  const release = processGovernor.reserve(kind);

  try {
    const child = start();
    void child.exited.finally(release).catch(() => {});

    return child;
  } catch (error) {
    release();
    throw error;
  }
}

export function governNodeSpawn<T extends ChildProcess>(kind: ProcessKind, start: () => T): T {
  const release = processGovernor.reserve(kind);

  try {
    const child = start();
    child.once("close", release);
    child.once("error", release);

    return child;
  } catch (error) {
    release();
    throw error;
  }
}

export interface ProcessInput {
  argv: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export class ProcessTimeoutError extends Error {
  constructor() {
    super("The process exceeded its time or output limit.");
  }
}

/** Hash the entire execution context, including env and stdin. No command or credential is logged. */
export function processKey(input: ProcessInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.argv,
        input.cwd ?? process.cwd(),
        Object.entries(input.env ?? process.env).sort(([a], [b]) => a.localeCompare(b)),
        input.input,
        input.timeoutMs,
        input.maxBytes,
      ]),
    )
    .digest("hex");
}

/** Kill only the owned process group. Windows taskkill /T is needed because kill(pid) is not recursive. */
export async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });

    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* Owned group already exited. */
  }
}

/** Bounded capture. Spawn errors and deadlines contain no argv, env or CLI output. */
export function runProcess(input: ProcessInput, policy: ProcessPolicy): Promise<ProcessResult> {
  return processGovernor.run(policy, () => capture(input));
}

function capture(input: ProcessInput): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    input.signal?.throwIfAborted();

    const child = spawn(input.argv[0]!, input.argv.slice(1), {
      cwd: input.cwd,
      env: input.env ?? process.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let bytes = 0;
    let stopped = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const stop = () => {
      if (stopped) return;
      stopped = true;

      if (child.pid) void killProcessTree(child.pid);
    };

    const append = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;

      if (bytes > (input.maxBytes ?? 8 * 1024 * 1024)) stop();
      else if (!stopped) chunks.push(chunk);
    };

    const timer = setTimeout(stop, input.timeoutMs ?? 15_000);
    input.signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    // A CLI may exit without consuming stdin (EPIPE is not an uncaught process error).
    child.stdin.on("error", () => {});
    child.stdin.end(input.input);

    const cleanup = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", stop);
    };

    child.once("error", () => {
      cleanup();
      reject(new Error("The executable could not be started."));
    });
    child.once("close", (code) => {
      cleanup();

      if (stopped) reject(new ProcessTimeoutError());
      else resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
    });
  });
}
