import { Option, Schema } from "effect";
import { redactConnector } from "./oauth.ts";
import { GitHubToolFailure, type GitHubRepositoryRequest } from "./github-repository-tools.ts";

const Branch = Schema.Struct({ ref: Schema.String });

const Item = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  pull_request: Schema.optional(Schema.JsonObject),
  merged: Schema.optional(Schema.Boolean),
  draft: Schema.optional(Schema.Boolean),
  head: Schema.optional(Branch),
  base: Schema.optional(Branch),
});

const File = Schema.Struct({
  type: Schema.Literal("file"),
  size: Schema.Int,
  sha: Schema.String,
  encoding: Schema.String,
  content: Schema.String,
});

function fileText(value: Schema.JsonObject, offset: number, secrets: readonly string[]) {
  const file = Option.getOrUndefined(Schema.decodeUnknownOption(File)(value));

  if (!file) throw new GitHubToolFailure("Choose a text file in the repository.");

  if (file.size > 1_048_576 || file.encoding !== "base64")
    throw new GitHubToolFailure("The file exceeds the 1 MiB text-file limit.");
  const bytes = Buffer.from(file.content, "base64");

  if (bytes.byteLength !== file.size) throw new GitHubToolFailure("GitHub returned incomplete file contents.");
  let content: string;

  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubToolFailure("The file is not UTF-8 text.");
  }

  if (content.includes("\0")) throw new GitHubToolFailure("The file contains binary data.");
  // GitHub returns base64. Redact the decoded text too, before dividing it into pages.
  const text = redactConnector(content, {}, secrets);
  const end = offset + 32_000;

  return { sha: file.sha, text: text.slice(offset, end), ...(end < text.length && { nextOffset: end }) };
}

function summary(repo: string, item: typeof Item.Type, pull: boolean, detail: boolean) {
  const body = item.body ?? "";

  return {
    number: item.number,
    title: item.title.slice(0, 512),
    state: item.merged ? "merged" : item.state.slice(0, 16),
    url: `https://github.com/${repo}/${pull ? "pull" : "issues"}/${item.number}`,
    ...(pull && { draft: item.draft ?? false, head: item.head?.ref.slice(0, 255), base: item.base?.ref.slice(0, 255) }),
    ...(detail && { body: body.slice(0, 32_000), ...(body.length > 32_000 && { truncated: true }) }),
  };
}

/** Return only fields consumed by the tool. GitHub's download URLs and other embedded resources stay upstream. */
export function githubRepositoryResult(
  repo: string,
  request: GitHubRepositoryRequest,
  value: Schema.JsonObject,
  secrets: readonly string[],
) {
  if (request.project === "file") return fileText(value, request.offset ?? 0, secrets);

  if (request.project === "issues" || request.project === "pulls") {
    const { items } = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Item) }))(value);
    const pulls = request.project === "pulls";
    const limit = request.perPage ?? 15;

    return {
      items: items
        .slice(0, limit)
        .filter((item) => pulls || !item.pull_request)
        .map((item) => summary(repo, item, pulls, false)),
      ...(items.length >= limit && { nextPage: (request.page ?? 1) + 1 }),
    };
  }

  if (request.project === "comment") {
    const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Int }))(value);

    return { id, url: `https://github.com/${repo}/issues/${request.number}#issuecomment-${id}` };
  }

  const item = Schema.decodeUnknownSync(Item)(value);
  const pull = request.project === "pull";

  if (item.pull_request && !pull)
    throw new GitHubToolFailure("This number identifies a pull request. Use read_pull_request.");

  return summary(repo, item, pull, !request.body);
}
