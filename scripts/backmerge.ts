import { api, dispatchRelease, git, repository } from "./release-github.ts";
import { compareTags } from "./version.ts";

export function runBackmerge(repo: string, stable: string, adapters = { git, api, dispatchRelease }): void {
  const { git, api, dispatchRelease } = adapters;

  for (const [source, target] of [
    ["main", "next"],
    ["next", "dev"],
  ] as const) {
    // Bootstrap runs before next/dev exist.
    try {
      git("rev-parse", "--verify", `origin/${target}`);
    } catch {
      console.log(`${target} does not exist yet; bootstrap must create it`);
      break;
    }

    const sourceRef = source === "main" ? stable : "origin/next";
    const sourceSha = git("rev-parse", sourceRef);

    const alreadyMerged = git("merge-base", `origin/${target}`, sourceSha) === sourceSha;

    if (alreadyMerged) continue;
    git("checkout", "-B", target, `origin/${target}`);

    try {
      git(
        "-c",
        "core.hooksPath=/dev/null",
        "merge",
        "--no-ff",
        sourceSha,
        "-m",
        `chore(release): back-merge ${source} into ${target}`,
      );
    } catch {
      git("merge", "--abort");

      const existing = api(`repos/${repo}/pulls?state=open&base=${target}&head=${repo.split("/")[0]}:${source}`);

      if (!Array.isArray(existing)) throw new Error("Invalid pull request list");

      if (!existing.length)
        api(`repos/${repo}/pulls`, "POST", {
          title: `chore(release): back-merge ${source} into ${target}`,
          head: source,
          base: target,
          body: `Automatic back-merge found conflicts. Resolve the hotfix in this PR. After the squash merge, run Back-merge again to restore ancestry with a merge commit before the next promotion. No force push is used.`,
        });
      console.log(`Conflicts: PR ${source} → ${target} needs a maintainer; downstream propagation paused`);
      break;
    }

    git("push", "origin", `HEAD:refs/heads/${target}`);
    const sha = git("rev-parse", "HEAD");

    // SSH pushes trigger Release for next; dev has no Release push trigger.
    if (target === "dev") dispatchRelease(repo, target, sha);
    git("fetch", "origin", target);
  }
}

if (import.meta.main) {
  const repo = repository();

  git("config", "user.name", "github-actions[bot]");
  git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  // --force: a tag-triggered checkout already holds the tag (lightweight), which a plain fetch refuses to replace.
  git("fetch", "origin", "--tags", "--force");

  const stable =
    process.env["STABLE_SHA"] ||
    git("tag", "--merged", "origin/main", "--list", "v*")
      .split("\n")
      .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
      .sort(compareTags)
      .at(-1);

  if (!stable) throw new Error("No stable release to back-merge");
  runBackmerge(repo, stable);
}
