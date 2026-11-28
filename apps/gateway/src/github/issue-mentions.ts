import { create, fromJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { parseIssueUrl } from "@canopy/domain";
import { objectOf, type JsonValue } from "@canopy/domain/json";
import { Code, ConnectError } from "@connectrpc/connect";
import { Option, Schema } from "effect";
import { matches } from "../connectors/issue-providers/common.ts";
import {
  githubMention,
  githubMentionQuery,
  type GitHubMentionKind,
  type GitHubMentionLookup,
} from "../connectors/issue-providers/github.ts";
import { digest, graphErrors, jsonMessage } from "./read-scope.ts";
import type { GitHubAccounts } from "./service.ts";

interface MentionPage {
  issues: ui.IssueSearchMatch[];
  connectedSources: number;
  warnings: string[];
  /** Validate the account again once all providers have finished searching. */
  isCurrent?: () => Promise<boolean>;
}

const origin = "https://github.com";
const kindLabels = { issue: "issues", pr: "pull requests" };
const nodeFields = { number: Schema.Number, title: Schema.String, body: Schema.String, url: Schema.String };

const node = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ __typename: Schema.Literal("Issue"), ...nodeFields, issueState: Schema.String }),
    Schema.Struct({
      __typename: Schema.Literal("PullRequest"),
      ...nodeFields,
      state: Schema.String,
      isDraft: Schema.Boolean,
    }),
  ]),
);

const searchResult = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({ search: Schema.Struct({ nodes: Schema.Array(Schema.Json) }) }),
  }),
);

const numberResult = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.Struct({ databaseId: Schema.Number, issueOrPullRequest: Schema.NullOr(Schema.JsonObject) }),
    }),
    errors: Schema.optional(
      Schema.Array(
        Schema.Struct({ type: Schema.optional(Schema.String), path: Schema.optional(Schema.Array(Schema.Json)) }),
      ),
    ),
  }),
);

interface MentionRead {
  lookup: GitHubMentionLookup;
  repositoryId: string;
  accountId: string;
  query: string;
  limit: number;
  signal: AbortSignal;
}

function fields(kind: GitHubMentionKind | undefined, search: boolean) {
  const repo = search ? "repository { databaseId }" : "";
  const issue = `... on Issue { number title body url issueState: state ${repo} }`;
  const pull = `... on PullRequest { number title body url state isDraft ${repo} }`;

  return `__typename ${kind === "pr" ? "" : issue} ${kind === "issue" ? "" : pull}`;
}

function graphRead(source: MentionRead, kind?: GitHubMentionKind) {
  const { lookup, limit, query } = source;
  const rate = "rateLimit { cost remaining resetAt }";

  if (lookup.number) {
    const [owner = "", name = ""] = lookup.repository.split("/");

    return {
      query: `query CanopyMentionNumber($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { databaseId issueOrPullRequest(number: $number) { ${fields(kind, false)} } }
        ${rate}
      }`,
      variables: { owner, name, number: lookup.number },
    };
  }

  return {
    query: `query CanopyMentionSearch($q: String!, $limit: Int!) {
      search(type: ISSUE, query: $q, first: $limit) { nodes { ${fields(kind, true)} } }
      ${rate}
    }`,
    variables: {
      q: `repo:${lookup.repository} is:${kind} ${query}${query === "is:open" ? " sort:updated-desc" : ""}`,
      limit,
    },
  };
}

function resultNodes(value: Schema.JsonObject, source: MentionRead) {
  if (source.lookup.number) {
    const {
      data: { repository },
      errors,
    } = numberResult(value);

    if (String(repository.databaseId) !== source.repositoryId) throw new Error("GitHub repository changed");

    // GitHub reports a missing number under an accessible repository as a field error.
    if (
      repository.issueOrPullRequest === null &&
      errors?.every(
        (e) =>
          e.type === "NOT_FOUND" &&
          e.path?.length === 2 &&
          e.path[0] === "repository" &&
          e.path[1] === "issueOrPullRequest",
      )
    )
      return [];

    if (graphErrors(value)) throw new Error("GitHub lookup failed");

    return repository.issueOrPullRequest ? [repository.issueOrPullRequest] : [];
  }

  if (graphErrors(value)) throw new Error("GitHub search failed");

  return searchResult(value).data.search.nodes.filter(
    (row) => objectOf(objectOf(row)["repository"])["databaseId"] === Number(source.repositoryId),
  );
}

function matchNode(value: JsonValue, lookup: GitHubMentionLookup, kind?: GitHubMentionKind) {
  const hit = Option.getOrUndefined(node(value));

  if (!hit) return;
  const isPull = hit.__typename === "PullRequest";

  if (kind && isPull !== (kind === "pr")) return;

  const state = isPull
    ? hit.isDraft && hit.state === "OPEN"
      ? "draft"
      : hit.state.toLowerCase()
    : hit.issueState.toLowerCase();

  return githubMention({ ...hit, state }, isPull ? "pr" : "issue", lookup);
}

async function readMentions(accounts: GitHubAccounts, source: MentionRead, kind?: GitHubMentionKind) {
  const graph = graphRead(source, kind);
  const key = digest(JSON.stringify([kind, graph.variables]));

  const cached = await accounts.prs.client.read(source.accountId, {
    key: `mentions:${source.repositoryId}:${key}`,
    path: "/graphql",
    ...graph,
    ttl: 30_000,
    signal: source.signal,
    project: async (value) => {
      const issues = matches(resultNodes(value, source), source.limit, (row) => matchNode(row, source.lookup, kind));

      return jsonMessage(ui.SearchIssuesResponseSchema, create(ui.SearchIssuesResponseSchema, { issues }));
    },
  });

  return fromJsonString(ui.SearchIssuesResponseSchema, JSON.stringify(cached.payload)).issues;
}

export async function searchGitHubMentions(
  accounts: GitHubAccounts,
  repository: string,
  query: string,
  includePullRequests: boolean,
  limit: number,
  signal: AbortSignal,
): Promise<MentionPage> {
  const page: MentionPage = { issues: [], connectedSources: 0, warnings: [] };

  if (!repository) return page;
  signal.throwIfAborted();

  const selected = await accounts.prs.repositories.selected(repository).catch((error) => {
    if (!(error instanceof ConnectError && [Code.InvalidArgument, Code.PermissionDenied].includes(error.code)))
      page.warnings.push("Could not check GitHub repository access. Check the connection or try again.");

    return undefined;
  });

  if (!selected) return page;
  page.connectedSources = 1;
  page.isCurrent = async () => {
    const current = await accounts.prs.repositories.selected(repository).catch(() => undefined);

    return (
      current?.row.id === selected.row.id &&
      current.row.revision === selected.row.revision &&
      current.mapping.repository_id === selected.mapping.repository_id &&
      current.mapping.revision === selected.mapping.revision
    );
  };

  const term = query.trim();
  const url = parseIssueUrl(term);

  if ((!url && (term.length > 256 || /^https?:\/\//i.test(term))) || (url && url.origin !== origin)) return page;
  const parsed = githubMentionQuery(term, url, { repository, includePullRequests });

  if (
    !parsed ||
    parsed.lookup.repository.toLowerCase() !== repository.toLowerCase() ||
    (parsed.lookup.number ?? 0) > 2_147_483_647
  )
    return page;

  const source: MentionRead = {
    lookup: { ...parsed.lookup, repository: repository.toLowerCase(), origin },
    repositoryId: selected.mapping.repository_id,
    accountId: selected.row.id,
    query: parsed.query,
    limit: Math.min(50, Math.max(1, Math.trunc(limit || 20))),
    signal,
  };

  // GitHub App user tokens must search each kind separately. A failure of one kind leaves the other usable.
  const kinds: (GitHubMentionKind | undefined)[] =
    parsed.lookup.number || parsed.kind ? [parsed.kind] : ["issue", "pr"];

  const pages = await Promise.allSettled(kinds.map((kind) => readMentions(accounts, source, kind)));

  const ranked = pages.flatMap((result, i) => {
    if (result.status === "fulfilled") return result.value.map((hit, rank) => ({ hit, rank }));
    const kind = kinds[i];
    const label = kind ? kindLabels[kind] : "issues and pull requests";
    page.warnings.push(`Could not search GitHub ${label}. Check the connection or try again.`);

    return [];
  });

  page.issues = ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, source.limit)
    .map(({ hit }) =>
      create(ui.IssueSearchMatchSchema, {
        ...hit,
        accountId: selected.row.id,
        accountLabel: selected.row.login,
        provider: "github",
      }),
    );

  return page;
}
