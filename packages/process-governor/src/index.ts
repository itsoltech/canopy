import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { processGovernor, type ProcessKind, type ProcessPolicy } from "./governor.ts";
import type { ChildProcess } from "node:child_process";
import { windowsCommand } from "./windows-command.ts";

export * from "./governor.ts";

export { windowsCommand } from "./windows-command.ts";

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
  /** Numeric diagnostics observe admission; never called for a cache hit or join. */
  onStart?: () => void;
  argv: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** A streaming consumer owns stderr retention; stdout remains bounded by maxBytes. */
  onStderr?: (chunk: Buffer) => void;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export class ProcessTimeoutError extends Error {
  constructor(
    readonly reason: "timeout" | "output" | "aborted",
    readonly treeTerminated: boolean,
  ) {
    // Existing callers display this message. Use reason when the caller can report each limit separately.
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
  await terminateProcessTree(pid);
}

async function terminateProcessTree(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    return new Promise<boolean>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("error", () => resolve(false));
      killer.once("close", (code) => resolve(code === 0));
    });
  }

  try {
    process.kill(-pid, "SIGKILL");

    return true;
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "ESRCH";
  }
}

/** Bounded capture. Spawn errors and deadlines contain no argv, env or CLI output. */
export function runProcess(input: ProcessInput, policy: ProcessPolicy): Promise<ProcessResult> {
  return processGovernor.run(policy, () => capture(input));
}

/** Share one admission and result for two sequential processes. The key identifies the whole operation. */
export function runPreparedProcess(
  setup: ProcessInput,
  command: (result: ProcessResult) => ProcessInput,
  policy: ProcessPolicy,
): Promise<ProcessResult> {
  return processGovernor.run(policy, async () => {
    const result = await capture(setup);

    return capture(command(result));
  });
}

function capture(input: ProcessInput): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    input.signal?.throwIfAborted();

    try {
      input.onStart?.();
    } catch {
      /* Observers cannot prevent execution. */
    }

    const command = windowsCommand(input.argv, input.env, process.platform, input.cwd);
    const argv = command.argv;

    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: input.cwd,
      env: input.env ?? process.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let bytes = 0;
    let stopped: ProcessTimeoutError["reason"] | undefined;
    let termination: Promise<boolean> | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const stop = (reason: ProcessTimeoutError["reason"]) => {
      if (stopped) return;
      stopped = reason;

      if (child.pid) termination = terminateProcessTree(child.pid);
    };

    const append = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;

      if (bytes > (input.maxBytes ?? 8 * 1024 * 1024)) stop("output");
      else if (!stopped) chunks.push(chunk);
    };

    const timer = setTimeout(() => stop("timeout"), input.timeoutMs ?? 15_000);
    const abort = () => stop("aborted");
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (input.onStderr) input.onStderr(chunk);
      else append(stderr, chunk);
    });
    // A CLI may exit without consuming stdin (EPIPE is not an uncaught process error).
    child.stdin.on("error", () => {});
    child.stdin.end(input.input);

    const cleanup = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    };

    child.once("error", () => {
      cleanup();
      reject(new Error("The executable could not be started."));
    });
    child.once("close", (code) => {
      cleanup();

      const reason = stopped;

      if (reason)
        void Promise.resolve(termination).then(
          (done) => reject(new ProcessTimeoutError(reason, done === true)),
          reject,
        );
      else resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
    });
  });
}
