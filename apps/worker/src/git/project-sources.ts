import { lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { git, GitError, gitMessage } from "./git.ts";
import { safeCloneUrl } from "@canopy/domain/clone-url";

/**
 * New project directories (docs/linked-computers.md, "Dodawanie projektu na dowolnym komputerze"): a fresh
 * `git init` or a clone, always one new directory directly inside an existing absolute parent. The name is a
 * single path segment, so nothing is written outside the parent, and an existing name (also a symlink) is refused.
 */

export const CLONE_TIMEOUT_MS = 5 * 60_000;

/** Transports git may use for a clone; `ext::` and `fd::` (command execution) stay blocked. */
const ALLOWED_PROTOCOLS = "https:http:ssh:git:file";

/**
 * Creates the new directory and returns it with its real parent; throws when either is not allowed. Created here
 * (mkdir fails if it appeared meanwhile), so a cleanup after a failed git only ever removes our own directory.
 */
export function newDirectory(parentPath: string, name: string) {
  if (!isAbsolute(parentPath)) throw new GitError("PATH_NOT_ABSOLUTE", "Choose an absolute parent directory.");

  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name) || name.length > 255)
    throw new GitError("INVALID_NAME", "Use a directory name without slashes.");

  let parent: string;

  try {
    parent = realpathSync(parentPath);
  } catch {
    throw new GitError("PATH_NOT_FOUND", `${parentPath} does not exist.`);
  }

  if (!statSync(parent).isDirectory()) throw new GitError("PATH_NOT_DIRECTORY", `${parentPath} is not a directory.`);
  const target = join(parent, name);

  try {
    lstatSync(target);
  } catch {
    try {
      mkdirSync(target);
    } catch {
      throw new GitError("PATH_EXISTS", `${name} could not be created in ${parentPath}.`);
    }

    return { parent, target };
  }

  throw new GitError("PATH_EXISTS", `${name} already exists in ${parentPath}.`);
}

/**
 * A remote git may clone from, without credentials in it: `https://user:token@…` would land in `.git/config`
 * and in error messages. The worker's own credential helpers and SSH keys apply instead.
 */
export function cloneUrl(url: string): string {
  const result = safeCloneUrl(url);

  if ("message" in result) throw new GitError(result.code, result.message);

  return result.url;
}

/** `git init` in a new directory; the directory is removed again when git fails. */
export async function initRepository(parentPath: string, name: string): Promise<string> {
  const { target } = newDirectory(parentPath, name);

  try {
    const result = await git(target, ["init", "-q"]);

    if (!result.ok) throw new GitError("INIT_FAILED", gitMessage(result.stderr));
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }

  return realpathSync(target);
}

/** `git clone` into a new directory; whatever a failed or timed-out clone left is removed. */
export async function cloneRepository(parentPath: string, name: string, url: string): Promise<string> {
  const remote = cloneUrl(url);
  const { parent, target } = newDirectory(parentPath, name);

  try {
    const result = await git(parent, ["clone", "-q", "--", remote, name], CLONE_TIMEOUT_MS, {
      env: { GIT_ALLOW_PROTOCOL: ALLOWED_PROTOCOLS },
    });

    if (!result.ok) {
      if (
        /authentication failed|permission denied|could not read (?:username|password)|terminal prompts disabled|repository not found|access denied|publickey/i.test(
          result.stderr,
        )
      )
        throw new GitError("CLONE_AUTH_FAILED", "Git sign-in is required.");
      throw new GitError(
        "CLONE_FAILED",
        "Could not clone the repository. Check the Git URL and connection, then retry.",
      );
    }
  } catch (error) {
    rmSync(target, { recursive: true, force: true });

    if (error instanceof GitError && error.code === "GIT_TIMEOUT")
      throw new GitError("CLONE_TIMEOUT", "Cloning stopped after 5 minutes. Check the connection and retry.");
    throw error;
  }

  return realpathSync(target);
}
