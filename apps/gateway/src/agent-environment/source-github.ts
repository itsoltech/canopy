import { createHash } from "node:crypto";
import type { ui } from "@canopy/contracts";
import { SKILL_FILE_BYTES, SKILL_TOTAL_BYTES } from "@canopy/domain/skill-artifact";
import { gitHubSourceId, sourceGitHubRepository } from "@canopy/domain/source-access";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import { Repository } from "../github/schemas.ts";
import { waitForRead } from "../github/client.ts";
import { githubFailure } from "../github/http.ts";
import type { GitHubAccounts } from "../github/service.ts";
import type { SourceReader, GitEntry } from "./source-git.ts";
import { sourceInvalid } from "./source-command.ts";

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const Size = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Commits = Schema.Struct({
  items: Schema.Array(Schema.Struct({ sha: Sha, commit: Schema.Struct({ tree: Schema.Struct({ sha: Sha }) }) })),
});

const Tree = Schema.Struct({
  sha: Sha,
  truncated: Schema.Boolean,
  tree: Schema.Array(
    Schema.Struct({
      mode: Schema.String,
      type: Schema.String,
      path: Schema.NonEmptyString,
      sha: Sha,
      size: Schema.optional(Size),
    }),
  ),
});

const Blob = Schema.Struct({ sha: Sha, encoding: Schema.Literal("base64"), content: Schema.String, size: Size });

function gitHubTree(tree: typeof Tree.Type, treeSha: string, selective: boolean) {
  if (tree.sha !== treeSha || tree.truncated)
    sourceInvalid("The repository tree is incomplete. Choose a smaller repository.");
  const sizes = new Map<string, number>();
  const entries: GitEntry[] = [];
  let total = 0;

  for (const item of tree.tree) {
    if (item.mode === "040000" && item.type === "tree") continue;

    if (!(item.mode === "100644" || item.mode === "100755") || item.type !== "blob" || item.size === undefined)
      sourceInvalid("Repositories containing symlinks, submodules or special entries are rejected.");

    total += item.size;

    if (entries.length >= 5000) sourceInvalid("The repository exceeds 5000 files. Use a smaller repository.");

    if (!selective && (item.size > 16 * SKILL_FILE_BYTES || total > 2 * SKILL_TOTAL_BYTES))
      sourceInvalid("The repository exceeds 16 MiB per file or 50 MiB total. Select a skill with --skill.");

    sizes.set(item.sha, item.size);
    entries.push({ path: item.path, oid: item.sha, executable: item.mode === "100755" });
  }

  return { entries, sizes };
}

/** Fetch only Git objects in the verified repository. URLs embedded in GitHub responses are never used. */
export class GitHubSource {
  constructor(
    private readonly accounts: GitHubAccounts,
    private readonly accountId: string,
    private readonly repositoryId: string,
    private readonly revision: bigint,
  ) {}

  private async get(path: string, signal?: AbortSignal) {
    const { value } = await this.accounts.access.authorized(this.accountId, ({ row, token, secrets }) => {
      if (row.revision !== this.revision)
        throw new ConnectError("GitHub access changed. Preview the source again.", Code.FailedPrecondition);

      return this.accounts.http.get(`/repositories/${this.repositoryId}/${path}`, token, signal, secrets);
    });

    return value;
  }

  /** Confirm contents permission at save time, including for fine-grained PATs with metadata-only access. */
  async confirm(commit: string, signal?: AbortSignal) {
    if (!Schema.is(Sha)(commit)) sourceInvalid("The source commit is missing. Preview the source again.");

    try {
      const object = Schema.decodeUnknownSync(Schema.Struct({ sha: Sha }))(
        await this.get(`git/commits/${commit}`, signal),
      );

      if (object.sha !== commit) sourceInvalid("The source commit changed. Preview the source again.");
    } catch (cause) {
      throw githubFailure(cause);
    }
  }

  async read<A>(ref: string, selective: boolean, read: SourceReader<A>, signal?: AbortSignal) {
    const query = new URLSearchParams({ per_page: "1" });

    if (ref && ref !== "HEAD") query.set("sha", ref);
    const commits = Schema.decodeUnknownSync(Commits)(await this.get(`commits?${query}`, signal));
    const commit = commits.items[0];

    if (!commit || (/^[a-f0-9]{40}$/i.test(ref) && commit.sha !== ref.toLowerCase()))
      sourceInvalid("GitHub could not find this ref. Check the branch, tag or commit.");

    const treeSha = commit.commit.tree.sha;
    const tree = Schema.decodeUnknownSync(Tree)(await this.get(`git/trees/${treeSha}?recursive=1`, signal));
    const { entries, sizes } = gitHubTree(tree, treeSha, selective);

    // Every entry comes from this one tree. The tree carries sizes before the first blob read.
    return read(commit.sha, entries, {
      prepare: async () => {},
      // SAFETY: each returned tree entry has a validated size keyed by the same object ID.
      size: (entry) => sizes.get(entry.oid)!,
      read: async (entry) => {
        const size = sizes.get(entry.oid);

        if (size === undefined || size > SKILL_FILE_BYTES) sourceInvalid("Skill files exceed the 1 MiB file limit.");
        const blob = Schema.decodeUnknownSync(Blob)(await this.get(`git/blobs/${entry.oid}`, signal));
        const data = Buffer.from(blob.content, "base64");
        const oid = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");

        if (oid !== entry.oid || blob.sha !== oid || size !== data.length || blob.size !== size)
          sourceInvalid("GitHub returned a different file. Preview the source again.");

        return data;
      },
    });
  }
}

export async function openGitHubSource(
  accounts: GitHubAccounts,
  selected: { user: string; repository: string },
  source: ui.SkillSource,
  signal?: AbortSignal,
) {
  const name = sourceGitHubRepository(source.url);

  if (!name || source.wellKnown)
    throw new ConnectError("Choose a GitHub repository for this source account.", Code.InvalidArgument);

  const [account] = await accounts.run((store) => store.sourceAccount(accounts.owner, selected.user));

  if (!account)
    throw new ConnectError(
      "Connect the source account in Settings → GitHub on this computer.",
      Code.FailedPrecondition,
    );

  try {
    signal?.throwIfAborted();
    const refreshing = accounts.catalogue.refresh(account.id, true);
    await (signal ? waitForRead(refreshing, signal) : refreshing);

    const denied = () =>
      new ConnectError(
        "This account cannot read the repository. Check its access in Settings → GitHub.",
        Code.PermissionDenied,
      );

    const installed =
      account.auth_kind === "device"
        ? (await accounts.run((store) => store.sourceInstallation(accounts.owner, account.id, name)))[0]
        : undefined;

    if (account.auth_kind === "device" && !installed) throw denied();
    const { value, row } = await accounts.access.get(account.id, `/repos/${name}`, signal);
    const repository = Schema.decodeUnknownSync(Repository)(value);
    const id = String(repository.id);

    if (
      row.auth_kind !== account.auth_kind ||
      repository.full_name.toLowerCase() !== name.toLowerCase() ||
      (row.auth_kind === "device" &&
        (!installed || installed.repository_id !== id || installed.revision !== row.revision)) ||
      (row.auth_kind === "pat" && !repository.permissions?.["pull"])
    )
      throw denied();

    if (selected.repository && selected.repository !== id)
      throw new ConnectError(
        "The GitHub repository changed. Import the new source separately.",
        Code.FailedPrecondition,
      );

    source.credentialAccountId = gitHubSourceId(selected.user, id);

    return new GitHubSource(accounts, account.id, id, row.revision);
  } catch (cause) {
    throw githubFailure(cause);
  }
}
