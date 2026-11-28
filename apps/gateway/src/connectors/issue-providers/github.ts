import { githubMentionTarget, parseIssueUrl, type JsonValue } from "@canopy/domain";
import { objectOf, isJsonArray } from "@canopy/domain/json";
import { Option, Schema } from "effect";
import { issue, matches, maybeText, payload, type IssueProviderOptions, type IssueToolCall } from "./common.ts";

const repositoryPattern = /^([a-z\d][\w.-]*)\/([\w.-]+)$/i;
const qualifiedNumber = /^([a-z\d][\w.-]*\/[\w.-]+)#([1-9]\d*)$/i;

const row = Schema.decodeUnknownOption(
  Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    html_url: Schema.String,
    state: maybeText,
    body: maybeText,
    merged: Schema.optional(Schema.Boolean),
    draft: Schema.optional(Schema.Boolean),
    pull_request: Schema.optional(Schema.NullOr(Schema.Struct({ merged_at: maybeText }))),
  }),
);

export type GitHubMentionKind = "issue" | "pr";

export interface GitHubMentionLookup {
  repository: string;
  number?: number;
  origin?: string;
}

export function githubMention(
  hit: {
    number: number;
    url: string;
    title: string;
    body?: string | null | undefined;
    state?: string | null | undefined;
  },
  kind: GitHubMentionKind,
  lookup: GitHubMentionLookup,
) {
  if (lookup.number && lookup.number !== hit.number) return;
  const url = parseIssueUrl(hit.url);
  const target = url && githubMentionTarget(url);

  if (!url || !target || target.number !== hit.number || target.pullRequest !== (kind === "pr")) return;

  if (lookup.origin && lookup.origin !== url.origin) return;

  if (lookup.repository && lookup.repository.toLowerCase() !== target.repository.toLowerCase()) return;

  const result = issue(`${target.repository}#${target.number}`, hit.title, url, hit.body, hit.state);

  return result && target.pullRequest ? { ...result, pullRequest: true } : result;
}

function githubMatch(value: JsonValue, kind: GitHubMentionKind, lookup: GitHubMentionLookup) {
  const hit = Option.getOrUndefined(row(value));

  if (!hit || (kind === "issue" && hit.pull_request)) return;
  let state = hit.state;

  if (kind === "pr" && (hit.merged || hit.pull_request?.merged_at)) state = "merged";
  else if (kind === "pr" && hit.draft && state === "open") state = "draft";

  return githubMention({ ...hit, url: hit.html_url, state }, kind, lookup);
}

async function readKind(
  kind: GitHubMentionKind,
  lookup: GitHubMentionLookup,
  query: string,
  limit: number,
  call: IssueToolCall,
) {
  const [owner, repo] = lookup.repository.split("/");
  const scoped = owner && repo ? { owner, repo } : {};

  if (lookup.number && lookup.repository) {
    const result =
      kind === "pr"
        ? await call("pull_request_read", { method: "get", ...scoped, pullNumber: lookup.number })
        : await call("issue_read", { method: "get", ...scoped, issue_number: lookup.number });

    const data = payload(result);
    const record = kind === "issue" ? (objectOf(data)["issue"] ?? data) : data;
    const match = githubMatch(record, kind, lookup);

    return match ? [match] : [];
  }

  const tool = kind === "pr" ? "search_pull_requests" : "search_issues";
  const data = payload(await call(tool, { query: `is:${kind} ${query}`, ...scoped, perPage: limit }));
  const rows = objectOf(data)["items"];

  if (!isJsonArray(rows)) throw new Error("Invalid GitHub search results");

  return matches(rows, limit, (item) => githubMatch(item, kind, lookup));
}

export function githubMentionQuery(term: string, url: URL | undefined, options: IssueProviderOptions) {
  const target = url && githubMentionTarget(url);

  if (url && (!target || (target.pullRequest && !options.includePullRequests))) return;
  const qualified = qualifiedNumber.exec(term);
  const repository = target?.repository ?? qualified?.[1] ?? options.repository ?? "";
  const repoMatch = repositoryPattern.exec(repository);

  if (repository && (!repoMatch || repoMatch[2] === "." || repoMatch[2] === "..")) return;
  const numberText = qualified?.[2] ?? /^#?([1-9]\d*)$/.exec(term)?.[1];
  const number = target?.number ?? (numberText ? Number(numberText) : undefined);

  if (number !== undefined && !Number.isSafeInteger(number)) return;

  // GitHub semantic search strips quotes. Keep user text out of its qualifier syntax.
  const words = term.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [];
  const text = words.map((word) => word.toLowerCase()).join(" ");

  if (term && !text) return;

  const open = repository ? "is:open" : "is:open involves:@me";
  const query = number?.toString() ?? (text ? `"${text}" in:title,body` : open);
  const lookup: GitHubMentionLookup = { repository, ...(number && { number }), ...(url && { origin: url.origin }) };

  const kind: GitHubMentionKind | undefined = target?.pullRequest
    ? "pr"
    : target || !options.includePullRequests
      ? "issue"
      : undefined;

  return { lookup, query, kind };
}

export async function githubIssues(
  term: string,
  url: URL | undefined,
  limit: number,
  call: IssueToolCall,
  options: IssueProviderOptions,
) {
  const parsed = githubMentionQuery(term, url, options);

  if (!parsed) return [];
  const { lookup, query, kind } = parsed;
  const read = (kind: GitHubMentionKind) => readKind(kind, lookup, query, limit, call);

  if (kind) return read(kind);

  const [issues, pulls] = await Promise.allSettled([read("issue"), read("pr")]);

  if (issues.status === "rejected" && pulls.status === "rejected") throw new Error("GitHub search failed");

  // Both kinds share a repository's number sequence. One exact hit fully answers that lookup.
  const pages = [issues, pulls].flatMap((page) => (page.status === "fulfilled" ? [page.value] : []));
  const exact = lookup.number && lookup.repository && pages.some((page) => page.length);

  if (!exact && issues.status === "rejected") options.onPartialFailure?.("issues");

  if (!exact && pulls.status === "rejected") options.onPartialFailure?.("pull requests");

  return pages
    .flatMap((page) => page.map((match, rank) => ({ match, rank })))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((entry) => entry.match);
}
