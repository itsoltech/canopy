import { lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { git, GitError, gitMessage } from "./git.ts";

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
  const value = url.trim();

  if (!value || value.startsWith("-") || /\s/.test(value)) throw new GitError("INVALID_URL", "Enter a Git URL.");

  if (/^[\w.-]+@[\w.-]+:[^:]/.test(value) && !value.includes("://")) return value;
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new GitError("INVALID_URL", "Enter a Git URL, e.g. https://github.com/owner/repo.git.");
  }

  if (!["https:", "http:", "ssh:", "git:", "file:"].includes(parsed.protocol))
    throw new GitError("INVALID_URL", "Use an https, ssh, git or file URL.");

  if (parsed.password || (parsed.username && parsed.protocol.startsWith("http")))
    throw new GitError(
      "URL_HAS_CREDENTIALS",
      "Remove the credentials from the URL. This computer's Git sign-in is used.",
    );

  return value;
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

    if (!result.ok) throw new GitError("CLONE_FAILED", gitMessage(result.stderr));
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }

  return realpathSync(target);
}
