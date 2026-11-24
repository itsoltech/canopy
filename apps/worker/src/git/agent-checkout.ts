import { lstatSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, GitError } from "./git.ts";
import type { NewWorktree } from "./worktree-rollback.ts";

// The new checkout can have a different effective configuration (includeIf.gitdir / includeIf.onbranch).
// Only built-in file/attribute conversion settings may cross into the private Git directory.
const checkoutSettings =
  "^core\\.(autocrlf|eol|safecrlf|checkroundtripencoding|symlinks|filemode|ignorecase|precomposeunicode|attributesfile|bigfilethreshold|sparsecheckout)$";

const unsupported = (detail: string) => new GitError("WORKTREE_CHECKOUT_FAILED", detail);

async function checkoutConfig(path: string): Promise<string[]> {
  const result = await git(path, ["config", "--null", "--get-regexp", checkoutSettings]);

  if (!result.ok && result.code !== 1) throw unsupported("Git could not read the worktree settings.");

  const settings = new Map<string, string>();

  for (const entry of result.stdout.split("\0").filter(Boolean)) {
    const cut = entry.indexOf("\n");
    const name = cut === -1 ? entry : entry.slice(0, cut);
    const value = cut === -1 ? "true" : entry.slice(cut + 1);

    settings.set(name, value);
  }

  if (!/^(?:false|no|off|0|)$/i.test(settings.get("core.sparsecheckout") ?? ""))
    throw new GitError("WORKTREE_SPARSE_UNSUPPORTED", "Agent worktree creation does not support sparse checkout.");

  return [...settings].flatMap(([name, value]) => ["-c", `${name}=${value}`]);
}

async function copyAttributes(common: string, scratch: string): Promise<void> {
  const source = join(common, "info", "attributes");
  const stat = lstatSync(source, { throwIfNoEntry: false });

  if (!stat) return;

  if (!stat.isFile()) throw unsupported("Git could not read the repository attributes for this worktree.");

  await mkdir(join(scratch, "info"));
  await copyFile(source, join(scratch, "info", "attributes"));
}

/** Populate the registered worktree using its real index and object store. The private gitdir has no
 * executable configuration, hooks, remote or promisor, even if the repository's policy changes mid-checkout. */
export async function populateAgentWorktree(tree: NewWorktree, metadata: string, timeoutMs: number): Promise<void> {
  const options = await checkoutConfig(tree.path);
  const common = dirname(dirname(metadata));
  const scratch = await mkdtemp(join(tmpdir(), "canopy-agent-checkout-"));

  try {
    await mkdir(join(scratch, "refs"));
    await writeFile(join(scratch, "HEAD"), tree.commit + "\n");
    await writeFile(
      join(scratch, "config"),
      tree.commit.length === 40 ? "" : "[core]\nrepositoryFormatVersion=1\n[extensions]\nobjectFormat=sha256\n",
    );
    await copyAttributes(common, scratch);

    const env = {
      GIT_DIR: scratch,
      GIT_COMMON_DIR: scratch,
      GIT_WORK_TREE: tree.path,
      GIT_INDEX_FILE: join(metadata, "index"),
      GIT_OBJECT_DIRECTORY: join(common, "objects"),
      GIT_CONFIG_GLOBAL: join(scratch, "empty-global"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_PARAMETERS: "",
    };

    const run = async (args: string[], text?: string) => {
      const result = await git(tree.path, [...options, ...args], undefined, {
        env,
        ...(text !== undefined && { text }),
      });

      if (!result.ok) throw unsupported("Git could not prepare the local commit for checkout.");

      return result.stdout;
    };

    await run(["read-tree", tree.commit]);
    // Git quotes paths as ASCII, including embedded newlines and non-UTF-8 bytes. check-attr --stdin decodes
    // that format itself. Compare a complete row to preserve filenames containing the output separator.
    const quoted = ["-c", "core.quotePath=true"];
    const paths = await run([...quoted, "ls-files"]);
    const rows = (await run([...quoted, "check-attr", "--cached", "--stdin", "filter"], paths)).split("\n");
    const names = paths.split("\n");

    if (
      rows.length !== names.length ||
      names.some(
        (name, i) => name && rows[i] !== `${name}: filter: unspecified` && rows[i] !== `${name}: filter: unset`,
      )
    )
      throw new GitError(
        "WORKTREE_FILTER_UNSUPPORTED",
        "This checkout uses Git filters. Create the worktree manually.",
      );

    // check-attr spells the two sentinel values the same way as a literal driver named unset or unspecified.
    const checked = await git(
      tree.path,
      [
        ...options,
        "-c",
        "filter.unset.required=true",
        "-c",
        "filter.unspecified.required=true",
        "checkout-index",
        "--all",
        "--index",
      ],
      timeoutMs,
      { env, finishAfterAdmission: true },
    );

    if (!checked.ok) throw unsupported("Git could not populate the worktree from the local commit.");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
