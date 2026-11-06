import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** A started `--version` run. `exited` resolves once the process is gone. */
export interface CheckProcess {
  readonly exited: Promise<number | null>;
  readonly output: Promise<{ stdout: string; stderr: string }>;
  signal(): string | null;
  kill(signal: NodeJS.Signals): void;
}

export type CheckSpawn = (path: string) => CheckProcess;

export interface CheckOptions {
  /** Hard upper bound for all three first launches together. */
  budget: number;
  /** Show the slow-check message once a launch takes this long. */
  slowAfter: number;
  /** How long to wait for a killed process and its output. */
  grace: number;
  spawn: CheckSpawn;
}

export type CheckFailureKind = "timeout" | "blocked" | "failed" | "version";

// macOS assesses newly written executables on their first launch (syspolicyd, XProtect).
// We measured 3.6 s for a cold `postgres --version` on an idle Mac, and 20 ms after that.
// A busy or freshly installed Mac can need much longer, so the bound is generous.
export const checkDefaults = { budget: 180_000, slowAfter: 5_000, grace: 2_000 } as const;

export function bunCheckSpawn(path: string): CheckProcess {
  const child = Bun.spawn([path, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });

  return {
    exited: child.exited,
    output: Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
      ([stdout, stderr]) => ({ stdout, stderr }),
    ),
    signal: () => (child.signalCode === null ? null : String(child.signalCode)),
    kill: (signal) => child.kill(signal),
  };
}

/** The user-facing message names the likely cause; `detail` goes to the desktop log only. */
export class PostgresCheckError extends Error {
  constructor(
    readonly kind: CheckFailureKind,
    readonly detail: string,
    platform: NodeJS.Platform,
    budget: number,
  ) {
    super(failureMessage(kind, platform, budget));
  }
}

function failureMessage(kind: CheckFailureKind, platform: NodeJS.Platform, budget: number) {
  const system = platform === "darwin" ? "macOS" : "Your computer";

  if (kind === "timeout")
    return `PostgreSQL did not respond within ${Math.max(1, Math.round(budget / 60_000))} min. ${system} may still be checking it for security. Try again.`;

  if (kind === "blocked")
    return platform === "darwin"
      ? "macOS stopped PostgreSQL from running. Check System Settings → Privacy & Security, then try again."
      : "Your computer stopped PostgreSQL from running. Check your security software, then try again.";

  if (kind === "version") return "Downloaded PostgreSQL reports an unexpected version. Try again.";

  return "Downloaded PostgreSQL could not run on this computer. Check the desktop logs, then try again.";
}

function slowMessage(platform: NodeJS.Platform) {
  return platform === "darwin"
    ? "Checking PostgreSQL with macOS security… This can take a minute the first time."
    : "Checking PostgreSQL… This can take a minute the first time.";
}

function clip(text: string, stage: string) {
  const line = text.replaceAll(stage, "<runtime>").replace(/\s+/g, " ").trim();

  return JSON.stringify(line.length > 500 ? `${line.slice(0, 500)}…` : line);
}

interface Launch {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  elapsed: number;
}

async function launch(path: string, remaining: number, options: CheckOptions, abort: AbortSignal): Promise<Launch> {
  const started = performance.now();
  const child = options.spawn(path);
  const output = child.output.catch(() => ({ stdout: "", stderr: "" }));
  const stop = new AbortController();
  const limit = delay(Math.max(0, remaining), "timeout" as const, { signal: AbortSignal.any([stop.signal, abort]) });
  limit.catch(() => {}); // Stopping the timer after an exit rejects it; nobody awaits that.
  let outcome: number | null | "timeout";

  try {
    outcome = await Promise.race([child.exited, limit]);
  } catch (error) {
    child.kill("SIGKILL");
    throw error; // Cancelled by the caller.
  } finally {
    stop.abort();
  }

  const timedOut = outcome === "timeout";

  // A process stuck in a security assessment may not exit at once. Never wait without a bound.
  if (timedOut) {
    child.kill("SIGKILL");
    await Promise.race([child.exited, delay(options.grace)]);
  }

  const text = await Promise.race([output, delay(options.grace, { stdout: "", stderr: "" })]);

  return {
    code: outcome === "timeout" ? null : outcome,
    signal: child.signal(),
    timedOut,
    ...text,
    elapsed: Math.round(performance.now() - started),
  };
}

/**
 * Runs `--version` on each binary within one shared, hard time budget.
 * Returns the launch times; throws PostgresCheckError with the exact cause in `detail`.
 */
export async function checkPostgres(
  stage: string,
  major: number,
  abort: AbortSignal,
  progress: (message: string) => void,
  options: CheckOptions = { ...checkDefaults, spawn: bunCheckSpawn },
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const deadline = performance.now() + options.budget;
  const expected = new RegExp(`PostgreSQL\\)? ${major}\\.`);
  const times: string[] = [];

  for (const name of ["postgres", "pg_ctl", "initdb"]) {
    const path = join(stage, "bin", name + (platform === "win32" ? ".exe" : ""));
    const slow = setTimeout(() => progress(slowMessage(platform)), options.slowAfter);
    let result: Launch;

    try {
      result = await launch(path, deadline - performance.now(), options, abort);
    } finally {
      clearTimeout(slow);
    }

    const kind: CheckFailureKind | undefined = result.timedOut
      ? "timeout"
      : result.signal
        ? "blocked"
        : result.code !== 0
          ? "failed"
          : expected.test(result.stdout)
            ? undefined
            : "version";

    if (kind) {
      const detail =
        `PostgreSQL check failed (${kind}): binary=${name} exit=${result.code ?? "none"} signal=${result.signal ?? "none"} ` +
        `timedOut=${result.timedOut} elapsed=${result.elapsed}ms budget=${options.budget}ms ` +
        `stdout=${clip(result.stdout, stage)} stderr=${clip(result.stderr, stage)}`;

      throw new PostgresCheckError(kind, detail, platform, options.budget);
    }

    times.push(`${name} ${result.elapsed} ms`);
  }

  return `PostgreSQL first launch: ${times.join(", ")}`;
}
