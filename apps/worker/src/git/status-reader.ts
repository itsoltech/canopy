import type { ThreadGitStatus } from "@canopy/contracts";
import { boundedGit, freshGit, GitError } from "./git.ts";
import { threadGitStatus } from "./thread-status.ts";

/** One complete scan per canonical checkout, regardless of thread, alias or subdirectory. No polling/cache. */
export class GitStatusReader {
  readonly #flights = new Map<string, Promise<ThreadGitStatus>>();

  read(root: string, expiresAt: bigint): Promise<ThreadGitStatus> {
    const existing = this.#flights.get(root);

    if (existing) return existing;

    if (this.#flights.size >= 32)
      throw new GitError("GIT_BUSY", "Too many checkouts are being read. Wait for them to finish.");
    const read = boundedGit(expiresAt, () => freshGit(() => threadGitStatus(root)));
    this.#flights.set(root, read);
    void read.finally(() => this.#flights.get(root) === read && this.#flights.delete(root)).catch(() => {});

    return read;
  }

  async settled(root: string): Promise<void> {
    await this.#flights.get(root)?.catch(() => {});
  }
}
