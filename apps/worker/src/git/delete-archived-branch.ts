import { realpathSync } from "node:fs";
import { deleteUnusedBranch, gitDirectoryIdentity } from "./branch-checkout-guards.ts";
import { FETCH_TIMEOUT_MS, freshGit, git, gitOk, validBranch } from "./git.ts";
import { githubRepository } from "./merged.ts";

export type BranchCleanupResult = "deleted" | "keep" | "retry";

interface MergeContext {
  readonly baseRef: string;
  readonly remote: string;
  readonly mergedPrRepository?: string;
  readonly mergedPrHead?: string;
}

const oid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

const protectedName =
  /^(?:main|master|trunk|dev|develop|development|next|stable|beta|alpha|nightly|release|releases|production|preprod|prod|uat|stage|staging|maintenance|maint|integration|qa)(?:[/.-]|$)/i;

export async function repositoryIdentity(repo: string): Promise<string> {
  const path = realpathSync(
    (await gitOk(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "GIT_FAILED")).trimEnd(),
  );

  return gitDirectoryIdentity(path);
}

/** Compare all paths changed by the branch, including deletions, binary blobs, modes and submodule commits.
 * A reverse patch can apply even when a deleted line is still present. Patch IDs also ignore whitespace.
 * For a squash, require the complete resulting state of every changed path in the independent base tree.
 */
async function containsChanges(repo: string, head: string, base: string): Promise<boolean> {
  if ((await git(repo, ["--no-replace-objects", "merge-base", "--is-ancestor", head, base])).ok) return true;
  const common = await git(repo, ["--no-replace-objects", "merge-base", "--all", head, base]);

  if (!common.ok || !oid(common.stdout.trim())) return false;

  const paths = async (from: string) =>
    (
      await gitOk(
        repo,
        [
          "--no-replace-objects",
          "diff",
          "--no-ext-diff",
          "--no-renames",
          "--ignore-submodules=none",
          "--name-only",
          "-z",
          from,
          head,
          "--",
        ],
        "GIT_FAILED",
      )
    )
      .split("\0")
      .filter(Boolean);

  const changed = await paths(common.stdout.trim());

  if (!changed.length) return false;
  const different = new Set(await paths(base));

  return changed.every((path) => !different.has(path));
}

function baseBranch(ref: string, remote: string): string {
  for (const prefix of ["refs/heads/", `refs/remotes/${remote}/`, `${remote}/`]) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }

  return ref;
}

/** Verify the actual advertised default even when the local remote/HEAD is stale or absent.
 * Use the advertised OIDs, so nonstandard fetch refspecs cannot substitute an unrelated tracking ref.
 */
async function remoteBases(repo: string, remote: string, base: string) {
  const listing = await gitOk(
    repo,
    ["ls-remote", "--symref", "--", remote, "HEAD", ...(base ? [`refs/heads/${base}`] : [])],
    "FETCH_FAILED",
    FETCH_TIMEOUT_MS,
  );

  const rows = listing
    .trimEnd()
    .split("\n")
    .map((line) => line.split("\t"));

  const target = rows.find(([ref, name]) => name === "HEAD" && ref?.startsWith("ref: refs/heads/"))?.[0]?.slice(16);

  if (!target || !(await validBranch(repo, target))) return;

  const commits = rows.flatMap(([hash = "", name]) =>
    oid(hash) && (name === "HEAD" || name === `refs/heads/${base}`) ? [hash] : [],
  );

  return { target, commits: [...new Set(commits)] };
}

async function localBases(repo: string, base: string): Promise<string[]> {
  const commits: string[] = [];

  for (const branch of new Set([base, "main", "master"].filter(Boolean))) {
    const ref = `refs/heads/${branch}`;

    const lines = await gitOk(
      repo,
      ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", ref],
      "GIT_FAILED",
    );

    const fields = lines
      .trimEnd()
      .split("\n")
      .map((line) => line.split("\0"));

    for (const [name, hash = "", symref] of fields) {
      if (name === ref && oid(hash) && symref === "") commits.push(hash);
    }
  }

  return commits;
}

async function remove(
  repo: string,
  branch: string,
  head: string,
  context: MergeContext,
  identity: string,
  current: () => boolean,
  consume: () => boolean,
): Promise<BranchCleanupResult> {
  const remote = context.remote || "origin";
  const base = baseBranch(context.baseRef, remote);

  if (
    !oid(head) ||
    !(await validBranch(repo, branch)) ||
    protectedName.test(branch) ||
    base.toLowerCase() === branch.toLowerCase()
  )
    return "keep";

  const ref = `refs/heads/${branch}`;

  const refs = await gitOk(
    repo,
    ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", ref, "refs/remotes"],
    "GIT_FAILED",
  );

  const rows = refs
    .trimEnd()
    .split("\n")
    .map((line) => line.split("\0"));

  if (!rows.some(([name, hash, symref]) => name === ref && hash === head && symref === "")) return "keep";

  const remotes = (await gitOk(repo, ["remote"], "GIT_FAILED")).split("\n").filter(Boolean);
  const names = [remote, ...remotes];

  if (
    rows.some(([name, , symref]) =>
      names.some(
        (r) =>
          name === `refs/remotes/${r}/HEAD` && symref?.toLowerCase() === `refs/remotes/${r}/${branch}`.toLowerCase(),
      ),
    )
  )
    return "keep";

  if (names.some((r) => baseBranch(context.baseRef, r).toLowerCase() === branch.toLowerCase())) return "keep";
  const initial = await git(repo, ["config", "--default", "master", "--get", "init.defaultBranch"]);

  if (!initial.ok) return "retry";

  if (initial.stdout.trim().toLowerCase() === branch.toLowerCase()) return "keep";

  const namedBase =
    base !== "HEAD" && !base.startsWith("refs/") && !oid(base) && (await validBranch(repo, base)) ? base : "";

  let merged = false;
  let commits: string[];

  if (remotes.length) {
    if (!remotes.includes(remote)) return "retry";

    for (const other of remotes.filter((name) => name !== remote)) {
      const advertised = await remoteBases(repo, other, "");

      if (!advertised) return "retry";

      if (advertised.target.toLowerCase() === branch.toLowerCase()) return "keep";
    }

    const result = await remoteBases(repo, remote, namedBase);

    if (!result) return "retry";

    if (result.target.toLowerCase() === branch.toLowerCase()) return "keep";
    commits = result.commits;

    if (context.mergedPrHead === head && context.mergedPrRepository) {
      const url = await git(repo, ["config", "--get", `remote.${remote}.url`]);
      merged = url.ok && githubRepository(url.stdout.trim()) === context.mergedPrRepository;
    }
  } else {
    commits = await localBases(repo, namedBase);
  }

  for (const commit of commits) {
    if (merged) break;

    if (remotes.length && !(await git(repo, ["cat-file", "-e", `${commit}^{commit}`])).ok) {
      // Fetch exactly the advertised object without changing any ref or the user's FETCH_HEAD.
      await gitOk(
        repo,
        ["fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", "--", remote, commit],
        "FETCH_FAILED",
        FETCH_TIMEOUT_MS,
      );
    }

    merged = await containsChanges(repo, head, commit);
  }

  if (!merged) return "retry";

  if ((await repositoryIdentity(repo)) !== identity) return "keep";

  const allowed = (common: string) => current() && gitDirectoryIdentity(common) === identity;

  return (await deleteUnusedBranch(repo, ref, head, allowed, consume)) ? "deleted" : "retry";
}

export async function deleteArchivedBranch(
  repo: string,
  branch: string,
  expectedHead: string,
  context: MergeContext,
  identity?: string,
  current = () => true,
  consume = () => true,
): Promise<BranchCleanupResult> {
  try {
    return await freshGit(async () =>
      remove(repo, branch, expectedHead, context, identity ?? (await repositoryIdentity(repo)), current, consume),
    );
  } catch {
    return "retry";
  }
}
