import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import { GitHubHttpFailure } from "./http.ts";
import type { GitPrContext } from "@canopy/contracts";

const Branch = Schema.Struct({ name: Schema.String, commit: Schema.Struct({ sha: Schema.String }) });

type Read = (path: string) => Promise<Schema.JsonObject>;

const missing = (cause: unknown) =>
  (cause instanceof GitHubHttpFailure && cause.status === 404) ||
  (cause instanceof ConnectError && cause.code === Code.NotFound);

export async function createBaseBranch(
  read: Read,
  repo: string,
  explicit: string,
  stored: string,
  fallback: string,
  context: GitPrContext,
) {
  const normalized = stored.replace(/^refs\/remotes\//, "").replace(/^refs\/heads\//, "");
  const remote = context.remotes.find((r) => normalized.startsWith(`${r.name}/`));
  const hint = remote ? normalized.slice(remote.name.length + 1) : normalized;
  const ref = explicit || hint || fallback;

  const get = async (name: string) =>
    Schema.decodeUnknownSync(Branch)(await read(`/repos/${repo}/branches/${encodeURIComponent(name)}`));

  try {
    return { ref, branch: await get(ref) };
  } catch (cause) {
    if (explicit || ref === fallback || !missing(cause)) throw cause;

    return { ref: fallback, branch: await get(fallback) };
  }
}

export async function createPublication(read: Read, repo: string, ref: string, sha: string) {
  try {
    const branch = Schema.decodeUnknownSync(Branch)(await read(`/repos/${repo}/branches/${encodeURIComponent(ref)}`));
    const published = branch.commit.sha === sha;

    return {
      published,
      detail: published ? "" : "This branch has unpushed commits. Push them with git or your agent, then refresh.",
    };
  } catch (cause) {
    if (!missing(cause)) throw cause;

    return {
      published: false,
      detail: "This branch is not published on GitHub. Push it with git or your agent, then refresh.",
    };
  }
}
