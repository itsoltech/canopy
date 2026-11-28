import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { freshGit, GitError } from "./git.ts";
import { atPath, registeredWorktrees } from "./worktree-rollback.ts";
import type { WorktreeInfoInit } from "./worktrees.ts";

/**
 * Agent checkouts the gateway may replay by command id (docs/thread-transfers.md): the worktree about to be added is
 * written down first, so a replay after the worker stopped between `git worktree add` and remembering the result
 * returns that worktree instead of failing on its now existing branch.
 */

const intent = z.object({
  repo: z.string(),
  path: z.string(),
  visiblePath: z.string(),
  branch: z.string(),
  commit: z.string(),
});

export type WorktreeIntent = z.infer<typeof intent>;

export class WorktreeIntents {
  readonly #dir: string;

  constructor(dataDir: string) {
    this.#dir = join(dataDir, "worktree-intents");
  }

  #path(commandId: string) {
    return join(this.#dir, `${createHash("sha256").update(commandId).digest("hex")}.json`);
  }

  record(commandId: string, plan: WorktreeIntent) {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const path = this.#path(commandId);
    writeFileSync(`${path}.part`, JSON.stringify(plan), { mode: 0o600 });
    renameSync(`${path}.part`, path);
  }

  /** The worktree an earlier run of this command added, when it is still there on its branch. */
  async recover(commandId: string): Promise<WorktreeInfoInit | undefined> {
    let text: string;

    try {
      text = readFileSync(this.#path(commandId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw unknown();
    }

    let raw: unknown;

    try {
      raw = JSON.parse(text);
    } catch {
      throw unknown();
    }

    const parsed = intent.safeParse(raw);

    // Unknown is not absent: the intent stays and the replay fails until it can tell.
    if (!parsed.success) throw unknown();
    const plan = parsed.data;

    const entries = await freshGit(() => registeredWorktrees(plan.repo)).catch(() => {
      throw unknown();
    });

    // The path as Git reports it on this system (separators, Windows short names).
    const found = atPath(entries, plan.path).some((fields) => fields.includes(`branch refs/heads/${plan.branch}`));

    if (!found) {
      rmSync(this.#path(commandId), { force: true });

      return undefined;
    }

    return {
      path: plan.visiblePath,
      branch: plan.branch,
      repoRoot: plan.repo,
      baseRef: plan.commit,
      baseCommit: plan.commit,
    };
  }
}

const unknown = () => new GitError("WORKTREE_STATE_UNKNOWN", "Canopy could not tell whether this worktree exists.");
