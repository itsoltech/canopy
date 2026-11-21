import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { basename, join, relative } from "node:path";
import { z } from "zod";
import { freshGit, git, GitError, validBranch } from "./git.ts";
import { withExpectedBranchTip } from "./branch-checkout-guards.ts";
import {
  atPath,
  onlyOwnedRegistration,
  planCheckout,
  registeredWorktrees,
  worktreeCommonDir,
  type CheckoutReservation,
  type NewWorktree,
} from "./worktree-rollback.ts";
import {
  directoryStillMatches,
  physicalDirectory,
  sameEntry,
  samePath,
  statPath,
  type Directory,
} from "./worktree-rollback-files.ts";
import { removeVerifiedCheckout } from "./failed-worktree-quarantine.ts";

const markerPattern = /^Canopy worktree creation ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;

const receiptSchema = z.object({
  path: z.string(),
  common: z.string(),
  branch: z.string(),
  commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  checkout: z.string(),
  admin: z.string(),
  repository: z.string(),
  stoppedAt: z.string().regex(/^[0-9]{1,24}$/),
});

const unverified = "Canopy could not verify a stopped checkout for this worktree.";
const registrationChanged = "The worktree registration changed. Refresh and check the worktree.";
const checkoutChanged = "The worktree folder has changed or contains files Canopy could not verify.";
const metadataChanged = "The worktree’s Git metadata changed or could not be verified.";
const branchChanged = "The worktree’s branch has changed or its creation could not be verified.";
const blocked = (message: string) => new GitError("WORKTREE_CLEANUP_BLOCKED", message);

function identity(stat: BigIntStats | undefined) {
  return stat?.ino ? `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` : undefined;
}

function incomplete(path: string, metadata: string): boolean {
  const link = statPath(join(path, ".git"));

  if ((link && (!link.isFile() || link.nlink !== 1n)) || statPath(join(metadata, "index"))) return false;
  const lock = statPath(join(metadata, "index.lock"));

  return Boolean(lock?.isFile() && lock.nlink === 1n && lock.size === 0n);
}

function snapshot(hash: ReturnType<typeof createHash>, path: string, directory: Directory): void {
  const add = (name: string, stat: BigIntStats) =>
    hash.update(
      JSON.stringify([name, identity(stat), ...[stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)]),
    );

  add(path, directory.stat);

  for (const name of [...directory.files.keys()].sort()) {
    const file = directory.files.get(name);

    if (file) add(join(path, name), file);
  }

  for (const name of [...directory.dirs.keys()].sort()) {
    const dir = directory.dirs.get(name);

    if (dir) snapshot(hash, join(path, name), dir);
  }
}

function initialMetadata(metadata: string, path: string, stat: BigIntStats, tree: NewWorktree): boolean {
  const name = relative(metadata, path);

  if (stat.isDirectory()) return name === "refs" || name === "logs";

  if (["commondir", "gitdir", "locked", "index.lock"].includes(name)) return true;

  if (stat.size > 4096n) return false;

  if (name === "HEAD") return readFileSync(path, "utf8").trimEnd() === `ref: refs/heads/${tree.branch}`;

  if (!samePath(name, join("logs", "HEAD"))) return false;

  const line = readFileSync(path, "utf8").trimEnd();

  return !line.includes("\n") && line.startsWith(`${"0".repeat(tree.commit.length)} ${tree.commit} `);
}

async function stillCreationBranch(repo: string, tree: NewWorktree, marker: string): Promise<boolean> {
  const ref = `refs/heads/${tree.branch}`;
  const refs = await git(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", "--", ref]);

  if (!refs.ok || refs.stdout.trimEnd() !== `${ref}\0${tree.commit}\0`) return false;
  const log = await git(repo, ["reflog", "show", "-2", "--format=%H%x00%gs", ref, "--"]);

  return log.ok && log.stdout.trimEnd() === `${tree.commit}\0${marker}`;
}

export class FailedWorktreeCleanup {
  readonly #removing = new Set<string>();

  constructor(private readonly dataDir: string) {}

  #root() {
    return join(realpathSync(this.dataDir), "failed-worktree-checkouts");
  }

  /** Only the creation path can write this, after the timed-out process tree stopped. */
  rememberStopped(tree: NewWorktree, marker: string, reservation: CheckoutReservation, stoppedAt: bigint): void {
    const key = markerPattern.exec(marker)?.[1];
    const checkout = physicalDirectory(tree.path);
    const admin = physicalDirectory(reservation.metadata);
    const common = join(reservation.metadata, "..", "..");
    const repository = physicalDirectory(common);
    const checkoutId = identity(checkout);
    const adminId = identity(admin);
    const repoId = identity(repository);

    if (
      !key ||
      !checkoutId ||
      !adminId ||
      !repoId ||
      !sameEntry(reservation.checkout, checkout) ||
      !sameEntry(reservation.common, repository) ||
      !incomplete(tree.path, reservation.metadata)
    )
      return;

    const root = this.#root();
    mkdirSync(root, { mode: 0o700, recursive: true });

    if (!physicalDirectory(root)) return;

    const receipt: z.infer<typeof receiptSchema> = {
      ...tree,
      common,
      checkout: checkoutId,
      admin: adminId,
      repository: repoId,
      stoppedAt: String(stoppedAt),
    };

    writeFileSync(join(root, key), JSON.stringify(receipt), { flag: "wx", mode: 0o600, flush: true });
  }

  async inspect(repo: string, path: string): Promise<{ token: string; reason: string }> {
    try {
      const { token } = await freshGit(() => this.#verify(repo, path));

      return { token, reason: "" };
    } catch (error) {
      return { token: "", reason: cleanupError(error instanceof GitError ? error : undefined).message };
    }
  }

  async remove(repo: string, path: string, token: string, assertIdle: () => void | Promise<void>): Promise<void> {
    if (!token) throw blocked("Refresh the worktree list and confirm cleanup again.");

    if (this.#removing.has(token)) throw blocked("Cleanup is already in progress for this worktree.");
    this.#removing.add(token);

    try {
      const current = await freshGit(() => this.#verify(repo, path)).catch((error: Error) => {
        throw cleanupError(error instanceof GitError ? error : undefined);
      });

      if (current.token !== token) throw blocked("The worktree changed. Refresh and confirm cleanup again.");
      const { common, tree, recheck } = current;

      const removed = await withExpectedBranchTip(common, `refs/heads/${tree.branch}`, tree.commit, async () => {
        await freshGit(recheck).catch((error: Error) => {
          throw cleanupError(error instanceof GitError ? error : undefined);
        });
        await assertIdle();
        removeVerifiedCheckout(current);

        try {
          unlinkSync(current.receiptPath);
        } catch {
          // A surviving receipt identifies deleted directories, so it cannot authorize another cleanup.
        }

        return true;
      });

      if (!removed)
        throw blocked("Git could not verify the local branch during cleanup. Refresh and check the worktree.");
    } finally {
      this.#removing.delete(token);
    }
  }

  async #verify(repo: string, path: string) {
    const entries = await registeredWorktrees(repo);
    const matches = atPath(entries, path);
    const lock = matches[0]?.find((field) => field.startsWith("locked "))?.slice(7) ?? "";
    const key = markerPattern.exec(lock)?.[1];

    if (matches.length !== 1 || !key) throw blocked(unverified);
    const root = this.#root();
    const receiptPath = join(root, key);
    const file = physicalDirectory(root) && statPath(receiptPath);

    if (!file?.isFile() || file.nlink !== 1n || file.size > 128_000n) throw blocked(unverified);
    const decoded = receiptSchema.safeParse(JSON.parse(readFileSync(receiptPath, "utf8")));

    if (!decoded.success) throw blocked(unverified);
    const tree = decoded.data;
    const common = await worktreeCommonDir(repo);
    const cwd = physicalDirectory(tree.path);
    const metadata = join(common, "worktrees", basename(tree.path));

    if (!samePath(tree.common, common) || identity(physicalDirectory(common)) !== tree.repository)
      throw blocked(registrationChanged);

    if (!cwd || identity(cwd) !== tree.checkout) throw blocked(checkoutChanged);

    if (identity(physicalDirectory(metadata)) !== tree.admin) throw blocked(metadataChanged);

    if (!atPath(matches, tree.path).length || !onlyOwnedRegistration(entries, tree, lock))
      throw blocked(registrationChanged);

    if (!(await validBranch(repo, tree.branch)) || !(await stillCreationBranch(repo, tree, lock)))
      throw blocked(branchChanged);

    if (!incomplete(tree.path, metadata))
      throw blocked("The checkout has an index, a changed index lock, or an invalid Git link.");

    const stoppedAt = BigInt(tree.stoppedAt);
    const unchangedSinceFailure = (stat: BigIntStats) => stat.mtimeNs < stoppedAt && stat.ctimeNs < stoppedAt;

    const plan = await planCheckout(repo, tree, lock, metadata, cwd, true, {
      metadataEntryAllowed: (path, stat) => unchangedSinceFailure(stat) && initialMetadata(metadata, path, stat, tree),
      unchangedSinceFailure,
    });

    if ("reason" in plan) throw blocked(plan.reason === "checkout changed" ? checkoutChanged : metadataChanged);

    const recheck = async () => {
      if (
        !(await stillCreationBranch(repo, tree, lock)) ||
        !onlyOwnedRegistration(await registeredWorktrees(repo), tree, lock) ||
        identity(physicalDirectory(common)) !== tree.repository
      )
        throw blocked("The worktree registration or branch changed. Refresh and check the worktree.");
    };

    await recheck();

    if (!directoryStillMatches(metadata, plan.admin) || !directoryStillMatches(tree.path, plan.checkout))
      throw blocked("The worktree changed during verification. Refresh to retry.");
    const hash = createHash("sha256").update(lock);
    snapshot(hash, metadata, plan.admin);
    snapshot(hash, tree.path, plan.checkout);

    return { token: hash.digest("hex"), metadata, plan, checkout: tree.path, receiptPath, common, tree, recheck };
  }
}

function cleanupError(error?: GitError): GitError {
  if (error?.code === "WORKTREE_CLEANUP_BLOCKED") return error;

  return blocked("Canopy could not finish checking or cleaning up the worktree. Refresh and check its status.");
}
