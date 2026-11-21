import { AsyncLocalStorage } from "node:async_hooks";
import { addAbortListener } from "node:events";
import { workerDiagnostics } from "../diagnostics/worker.ts";
import { gitReadEnv, runGitScan, withoutGitHooks } from "./read-policy.ts";
import type { GitFamily } from "@canopy/domain/diagnostics";
import {
  WORKTREE_CHECKOUT_TIMEOUT_MS,
  WORKTREE_PREPARATION_TIMEOUT_MS,
  WORKTREE_SETTLEMENT_TIMEOUT_MS,
} from "@canopy/domain/worktree-timing";
import {
  processGovernor,
  processKey,
  runProcess,
  ProcessTimeoutError,
  ProcessBusyError,
} from "@canopy/process-governor";

const freshness = new AsyncLocalStorage<boolean>();
export const freshGit = <T>(run: () => Promise<T>): Promise<T> => freshness.run(true, run);
const deadline = new AsyncLocalStorage<{ signal: AbortSignal; worktreeSettleBy?: number }>();

/** Complete data recovery even after the original mutation deadline expires. */
export const recoverGit = <T>(run: () => Promise<T>): Promise<T> => deadline.exit(run);

/** Includes governor admission, every validation and the mutation; expired commands never spawn git. */
export function boundedGit<T>(expiresAt: bigint, run: () => Promise<T>): Promise<T> {
  const remaining = Math.min(90_000, Number(expiresAt) - Date.now());

  if (remaining <= 0) throw new GitError("SWITCH_EXPIRED", "The Git operation expired. Try again.");

  return deadline.run({ signal: AbortSignal.timeout(remaining) }, run);
}

function worktreePreparationExpired(cause?: unknown): GitError {
  return new GitError("GIT_BUSY", "The worker could not prepare the worktree in time. Try again.", { cause });
}

/** Bound pre-checkout work including time spent waiting behind another creation or for a Git slot. */
export function prepareWorktreeGit<T>(startDeadlineMs: bigint, run: () => Promise<T>): Promise<T> {
  if (startDeadlineMs === 0n) return run();
  const remaining = Math.min(WORKTREE_PREPARATION_TIMEOUT_MS, Number(startDeadlineMs) - Date.now());

  if (remaining <= 0) throw worktreePreparationExpired();
  const signal = AbortSignal.timeout(remaining);

  const worktreeSettleBy =
    performance.now() + remaining + WORKTREE_CHECKOUT_TIMEOUT_MS + WORKTREE_SETTLEMENT_TIMEOUT_MS;

  return deadline.run({ signal, worktreeSettleBy }, run);
}

/** Let verification and rollback run after preparation expires, within the time reserved for settlement. */
export async function settleWorktreeGit<T>(run: () => Promise<T>): Promise<T> {
  const worktreeSettleBy = deadline.getStore()?.worktreeSettleBy;

  if (worktreeSettleBy === undefined) return recoverGit(run);
  const remaining = Math.min(WORKTREE_SETTLEMENT_TIMEOUT_MS, Math.ceil(worktreeSettleBy - performance.now()));

  if (remaining <= 0) throw new GitError("GIT_BUSY", "The worker could not finish the worktree in time.");

  return deadline.run({ signal: AbortSignal.timeout(remaining), worktreeSettleBy }, run);
}

/** A queued request can expire while the preceding checkout still owns the repository slot. */
export async function waitForWorktreeSlot(previous: Promise<void>): Promise<void> {
  const signal = deadline.getStore()?.signal;

  if (!signal) return previous;

  if (signal.aborted) throw worktreePreparationExpired();
  const expired = Promise.withResolvers<never>();
  using _listener = addAbortListener(signal, () => expired.reject(worktreePreparationExpired()));
  await Promise.race([previous, expired.promise]);
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
    options?: ErrorOptions,
  ) {
    super(message, options);
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
  input?: { text?: string; env?: Record<string, string>; maxBytes?: number; finishAfterAdmission?: boolean },
): Promise<GitResult> {
  const limit = deadline.getStore();
  const signal = limit?.signal;
  const worktree = limit?.worktreeSettleBy !== undefined;

  const expiry = worktree
    ? worktreePreparationExpired
    : (cause?: unknown) => new GitError("SWITCH_EXPIRED", "The Git operation expired. Try again.", { cause });

  if (signal?.aborted) throw expiry();

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

  const scan = args[0] === "status" || args[0] === "diff";

  const scanArgs =
    args[0] === "status"
      ? ["status", "--ignore-submodules=dirty", ...args.slice(1)]
      : ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty", ...args.slice(1)];

  const processSignal = input?.finishAfterAdmission ? undefined : signal;
  const scanSignal = scan ? (processSignal ?? AbortSignal.timeout(timeoutMs)) : processSignal;

  const command = {
    // git diff can refresh worktree index stat entries even with GIT_OPTIONAL_LOCKS=0.
    argv: scan
      ? ["git", ...scanArgs]
      : ["git", ...(read ? withoutGitHooks : []), "-c", "diff.autoRefreshIndex=false", ...args],
    cwd,
    env: { ...(scan ? gitReadEnv() : process.env), ...GIT_ENV, ...input?.env },
    timeoutMs,
    ...(input?.maxBytes !== undefined && { maxBytes: input.maxBytes }),
    ...(scanSignal && { signal: scanSignal }),
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
    const run = scan ? runGitScan : runProcess;

    const result = await run(
      { ...command, ...(timing && { onStart: timing.start }) },
      {
        kind: "git",
        ...(worktree && signal && { signal }),
        ...(read && !freshness.getStore() && { key: processKey(command), ttlMs: 1_000 }),
      },
    );

    failed = result.code !== 0;

    return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (signal?.aborted && (!input?.finishAfterAdmission || !(error instanceof ProcessTimeoutError)))
      throw expiry(error);

    if (error instanceof ProcessBusyError) throw new GitError("GIT_BUSY", error.message);

    if (error instanceof ProcessTimeoutError) {
      if (error.reason === "output")
        throw new GitError("GIT_OUTPUT_LIMIT", "Git produced too much output.", { cause: error });

      if (error.reason === "timeout")
        throw new GitError("GIT_TIMEOUT", "Git exceeded its time limit.", { cause: error });
      throw new GitError("GIT_CANCELLED", "Git was cancelled.", { cause: error });
    }

    throw new GitError("GIT_UNAVAILABLE", "Git could not start on the worker. Check the Git installation.");
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
