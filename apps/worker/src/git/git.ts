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

const ENV = {
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
  let proc;

  try {
    proc = Bun.spawn(["git", ...args], {
      cwd,
      env: { ...process.env, ...ENV, ...input?.env },
      stdin: input?.text === undefined ? "ignore" : new TextEncoder().encode(input.text),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new GitError("GIT_UNAVAILABLE", "git is not installed on this worker");
  }

  const timer = setTimeout(() => proc.kill(), timeoutMs);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (proc.signalCode) throw new GitError("GIT_TIMEOUT", `git ${args[0]} took longer than ${timeoutMs / 1000} s`);

    return { ok: code === 0, stdout, stderr };
  } finally {
    clearTimeout(timer);
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
