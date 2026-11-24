import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ThreadGitHeadSchema } from "@canopy/contracts";
import { git } from "./git.ts";

export type ThreadGitHeadInit = MessageInitShape<typeof ThreadGitHeadSchema>;

/** HEAD changes come in bursts (a lock file, then the rename): read once they settle. */
const SETTLE_MS = 150;

/** A read git could not answer (busy, timeout) is tried again a few times. */
const RETRY_MS = 1_000;
const RETRIES = 5;

export interface GitHead {
  readonly branch: string;
  readonly detachedCommit: string;
}

/** The checkout's own git directory (a worktree's is under the main repository's `.git/worktrees`). */
async function gitDirOf(cwd: string): Promise<string | undefined> {
  const result = await git(cwd, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"]).catch(() => undefined);

  return result?.ok ? result.stdout.trim() || undefined : undefined;
}

/** The branch HEAD names, else the short commit of a detached HEAD; undefined when git cannot tell. */
export async function readHead(cwd: string): Promise<GitHead | undefined> {
  const dir = await gitDirOf(cwd);

  return dir ? readHeadFile(dir) : undefined;
}

/** Watching atomic HEAD replacement never starts a process. Seven hex digits match git's usual short SHA. */
async function readHeadFile(dir: string): Promise<GitHead | undefined> {
  const value = await readFile(join(dir, "HEAD"), "utf8").catch(() => "");
  const head = value.trim();

  if (head.startsWith("ref: refs/heads/")) return { branch: head.slice(16), detachedCommit: "" };

  return /^[0-9a-f]{40,64}$/.test(head) ? { branch: "", detachedCommit: head.slice(0, 7) } : undefined;
}

interface ThreadCheckout {
  cwd: string;
  gitDir?: string;
  pending?: Promise<void>;
}

interface Checkout {
  readonly gitDir: string;
  readonly threads: Map<string, string>;
  watcher?: FSWatcher;
  head?: GitHead;
  timer?: ReturnType<typeof setTimeout>;
  retries: number;
}

/**
 * The live branch of each thread's checkout (docs/worktrees.md, "Bieżąca gałąź"). One watch per git directory on
 * its HEAD file, a read at every turn end (a missed or unsupported watch), and the full state after each
 * connection. Only changes are sent.
 */
export class HeadTracker {
  readonly #checkouts = new Map<string, Checkout>();
  readonly #threads = new Map<string, ThreadCheckout>();
  #closed = false;

  constructor(readonly send: (heads: ThreadGitHeadInit[]) => void) {}

  /** A thread works in `cwd`; outside a git checkout nothing is tracked. */
  track(threadId: string, cwd: string): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const previous = this.#threads.get(threadId);

    if (previous?.cwd === cwd) return previous.pending ?? Promise.resolve();

    this.untrack(threadId);
    const binding: ThreadCheckout = { cwd };
    this.#threads.set(threadId, binding);
    binding.pending = Promise.resolve()
      .then(async () => {
        const dir = await gitDirOf(cwd);

        if (!dir || this.#closed || this.#threads.get(threadId) !== binding) return;
        binding.gitDir = dir;
        const known = this.#checkouts.get(dir);

        if (known) {
          known.threads.set(threadId, cwd);

          if (known.head) this.send(this.#messages(known, known.head));

          return;
        }

        const checkout: Checkout = { gitDir: dir, threads: new Map([[threadId, cwd]]), retries: 0 };
        this.#checkouts.set(dir, checkout);

        try {
          checkout.watcher = watch(dir, { persistent: false }, (_event, name) => {
            if (!name || name === "HEAD") this.#schedule(checkout);
          });
          checkout.watcher.on("error", () => checkout.watcher?.close());
        } catch {
          // No watch (limits, file system): turn ends still read HEAD.
        }

        await this.#read(checkout, true);
      })
      .finally(() => {
        delete binding.pending;

        if (!binding.gitDir && this.#threads.get(threadId) === binding) this.#threads.delete(threadId);
      });

    return binding.pending;
  }

  /** A turn of the thread ended: read its HEAD now. */
  async check(threadId: string): Promise<void> {
    await this.#threads.get(threadId)?.pending;
    const checkout = this.#checkouts.get(this.#threads.get(threadId)?.gitDir ?? "");

    if (checkout) await this.#read(checkout, false);
  }

  untrack(threadId: string): void {
    const dir = this.#threads.get(threadId)?.gitDir;
    this.#threads.delete(threadId);

    if (!dir) return;
    const checkout = this.#checkouts.get(dir);
    checkout?.threads.delete(threadId);

    if (checkout && checkout.threads.size === 0) {
      this.#checkouts.delete(dir);
      this.#stop(checkout);
    }
  }

  /** Everything known, after a (re)connection: the gateway may have missed changes while the link was down. */
  snapshot(): void {
    const heads = [...this.#checkouts.values()].flatMap((c) => (c.head ? this.#messages(c, c.head) : []));

    if (heads.length) this.send(heads);
  }

  close(): void {
    this.#closed = true;

    for (const checkout of this.#checkouts.values()) this.#stop(checkout);
    this.#checkouts.clear();
    this.#threads.clear();
  }

  #stop(checkout: Checkout): void {
    checkout.watcher?.close();
    clearTimeout(checkout.timer);
  }

  #schedule(checkout: Checkout, delay = SETTLE_MS): void {
    clearTimeout(checkout.timer);
    checkout.timer = setTimeout(() => void this.#read(checkout, false), delay);
    checkout.timer.unref?.();
  }

  async #read(checkout: Checkout, always: boolean): Promise<void> {
    const head = await readHeadFile(checkout.gitDir);

    if (this.#closed || this.#checkouts.get(checkout.gitDir) !== checkout) return;

    if (!head) {
      if (checkout.retries++ < RETRIES) this.#schedule(checkout, RETRY_MS);

      return;
    }

    checkout.retries = 0;
    const changed = head.branch !== checkout.head?.branch || head.detachedCommit !== checkout.head?.detachedCommit;
    checkout.head = head;

    if (changed || always) this.send(this.#messages(checkout, head));
  }

  #messages(checkout: Checkout, head: GitHead): ThreadGitHeadInit[] {
    const byCwd = Map.groupBy([...checkout.threads], ([, cwd]) => cwd);

    return [...byCwd].map(([cwd, threads]) => ({ ...head, cwd, threadIds: threads.map(([id]) => id) }));
  }
}
