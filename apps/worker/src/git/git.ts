import { AsyncLocalStorage } from "node:async_hooks";
import { workerDiagnostics } from "../diagnostics/worker.ts";
import type { GitFamily } from "@canopy/domain/diagnostics";
import {
  processGovernor,
  processKey,
  runProcess,
  ProcessTimeoutError,
  ProcessBusyError,
} from "@canopy/process-governor";

const freshness = new AsyncLocalStorage<boolean>();
export const freshGit = <T>(run: () => Promise<T>): Promise<T> => freshness.run(true, run);
const deadline = new AsyncLocalStorage<AbortSignal>();

/** Includes governor admission, every validation and the mutation; expired commands never spawn git. */
export function boundedGit<T>(expiresAt: bigint, run: () => Promise<T>): Promise<T> {
  const remaining = Math.min(90_000, Number(expiresAt) - Date.now());

  if (remaining <= 0) throw new GitError("SWITCH_EXPIRED", "The branch switch expired. Try again.");

  return deadline.run(AbortSignal.timeout(remaining), run);
}

/**
 * Git for worktrees (docs/worktrees.md): always the `git` binary with an argument list (never a shell), no prompts
 * (a fetch that needs credentials fails instead of waiting) and a time limit. Errors keep git's first lines only,
 * with URLs' credentials removed.
 */

export const GIT_TIMEOUT_MS = 15_000;
export const FETCH_TIMEOUT_MS = 20_000;

export class GitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_SSH_COMMAND: process.env["GIT_SSH_COMMAND"] ?? "ssh -o BatchMode=yes",
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
};

/** One line of git's error output, without credentials in URLs (`https://user:token@host`). */
export function gitMessage(stderr: string): string {
  const line =
    stderr
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "git failed";

  return line.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, "[remote URL]").slice(0, 300);
}

/** Runs git in `cwd`; a non-zero exit is a result (ok: false), a missing binary or a timeout is a GitError. */
export async function git(
  cwd: string,
  args: readonly string[],
  timeoutMs = GIT_TIMEOUT_MS,
  input?: { text?: string; env?: Record<string, string> },
): Promise<GitResult> {
  const signal = deadline.getStore();

  if (signal?.aborted) throw new GitError("SWITCH_EXPIRED", "The branch switch expired. Try again.");

  const read =
    !input?.text &&
    !input?.env &&
    ([
      "status",
      "rev-list",
      "rev-parse",
      "symbolic-ref",
      "for-each-ref",
      "check-ref-format",
      "diff",
      "merge-base",
      "cherry",
    ].includes(args[0] ?? "") ||
      (args[0] === "worktree" && args[1] === "list") ||
      (args[0] === "remote" && args.length === 1) ||
      (args[0] === "config" && args[1] === "--get"));

  const command = {
    argv: ["git", ...args],
    cwd,
    env: { ...process.env, ...GIT_ENV, ...input?.env },
    timeoutMs,
    ...(signal && { signal }),
    ...(input?.text !== undefined && { input: input.text }),
  };

  if (!read) processGovernor.invalidate();

  const family: GitFamily =
    args[0] === "status" || args[0] === "diff"
      ? "status"
      : args[0] === "fetch"
        ? "fetch"
        : args[0] === "worktree"
          ? "worktree"
          : ["rev-list", "rev-parse", "symbolic-ref", "for-each-ref", "merge-base", "cherry", "show-ref"].includes(
                args[0] ?? "",
              )
            ? "refs"
            : "other";

  const timing = workerDiagnostics.enabled ? workerDiagnostics.git(family) : undefined;
  let failed = true;

  try {
    const result = await runProcess(
      { ...command, ...(timing && { onStart: timing.start }) },
      {
        kind: "git",
        ...(read && !freshness.getStore() && { key: processKey(command), ttlMs: 1_000 }),
      },
    );

    failed = result.code !== 0;

    return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (signal?.aborted) throw new GitError("SWITCH_EXPIRED", "The branch switch expired. Try again.");

    if (error instanceof ProcessBusyError) throw new GitError("GIT_BUSY", error.message);

    if (error instanceof ProcessTimeoutError)
      throw new GitError("GIT_TIMEOUT", "git exceeded its time or output limit");
    throw new GitError("GIT_UNAVAILABLE", "git is not installed on this worker");
  } finally {
    timing?.end(failed);

    if (!read) processGovernor.invalidate();
  }
}

/** Like git(), but a failure is a GitError with git's message. */
export async function gitOk(cwd: string, args: readonly string[], code: string, timeoutMs?: number): Promise<string> {
  const result = await git(cwd, args, timeoutMs);

  if (!result.ok) throw new GitError(code, gitMessage(result.stderr));

  return result.stdout;
}

/** A branch name git accepts (`check-ref-format --branch`), or undefined. */
export async function validBranch(cwd: string, name: string): Promise<boolean> {
  if (!name || name.startsWith("-")) return false;

  return (await git(cwd, ["check-ref-format", "--branch", name])).ok;
}
