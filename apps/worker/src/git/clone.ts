import { lstatSync, realpathSync, rmSync } from "node:fs";
import { processGovernor, runProcess, ProcessBusyError, ProcessTimeoutError } from "@canopy/process-governor";
import type { CloneProgress } from "@canopy/contracts";
import { GIT_ENV, GitError } from "./git.ts";
import { cloneUrl, newDirectory } from "./project-sources.ts";
import { CloneReporter } from "./clone-progress.ts";

export const CLONE_STALL_TIMEOUT_MS = 2 * 60_000;
export const CLONE_TIMEOUT_MS = 60 * 60_000;
const ALLOWED_PROTOCOLS = "https:http:ssh:git:file";

export interface CloneOptions {
  commandId?: string;
  signal?: AbortSignal;
  progress?: (progress: CloneProgress) => void;
  /** Short deadlines for real worker integration fixtures. */
  stallTimeoutMs?: number;
  overallTimeoutMs?: number;
}

/** Owned directory and process group only. Abort completes after git exits and cleanup finishes. */
export async function cloneRepository(
  parentPath: string,
  name: string,
  url: string,
  options: CloneOptions = {},
): Promise<string> {
  const remote = cloneUrl(url);
  options.signal?.throwIfAborted();
  const { parent, target } = newDirectory(parentPath, name);
  const owned = lstatSync(target);
  const stalled = new AbortController();
  const signal = AbortSignal.any([stalled.signal, ...(options.signal ? [options.signal] : [])]);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const activity = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stalled.abort(), options.stallTimeoutMs ?? CLONE_STALL_TIMEOUT_MS);
  };

  const reporter = new CloneReporter(options.commandId ?? "", options.progress ?? (() => {}), activity);
  processGovernor.invalidate();
  activity();

  try {
    const result = await runProcess(
      {
        argv: ["git", "clone", "--progress", "--", remote, name],
        cwd: parent,
        env: { ...process.env, ...GIT_ENV, GIT_ALLOW_PROTOCOL: ALLOWED_PROTOCOLS },
        signal,
        timeoutMs: options.overallTimeoutMs ?? CLONE_TIMEOUT_MS,
        onStderr: (chunk) => reporter.write(chunk),
      },
      { kind: "git", signal },
    );

    clearTimeout(timer);
    await reporter.finish();

    if (options.signal?.aborted) throw new GitError("CLONE_CANCELLED", "Cloning cancelled. Retry when ready.");

    if (result.code !== 0) {
      if (reporter.authenticationFailed) throw new GitError("CLONE_AUTH_FAILED", "Git sign-in is required.");
      throw new GitError(
        "CLONE_FAILED",
        "Could not clone the repository. Check the Git URL and connection, then retry.",
      );
    }

    return realpathSync(target);
  } catch (error) {
    const current = lstatSync(target, { throwIfNoEntry: false });

    if (current?.isDirectory() && current.dev === owned.dev && current.ino === owned.ino)
      rmSync(target, { recursive: true, force: true });

    if (options.signal?.aborted) throw new GitError("CLONE_CANCELLED", "Cloning cancelled. Retry when ready.");

    if (stalled.signal.aborted)
      throw new GitError("CLONE_STALLED", "Cloning made no progress for 2 minutes. Check the connection and retry.");

    if (error instanceof ProcessTimeoutError)
      throw new GitError("CLONE_TIMEOUT", "Cloning stopped after 60 minutes. Check the connection and retry.");

    if (error instanceof ProcessBusyError) throw new GitError("GIT_BUSY", error.message);

    if (error instanceof GitError) throw error;
    throw new GitError("GIT_UNAVAILABLE", "Git could not start on this worker. Check its Git installation and retry.");
  } finally {
    clearTimeout(timer);
    await reporter.finish();
    processGovernor.invalidate();
  }
}
