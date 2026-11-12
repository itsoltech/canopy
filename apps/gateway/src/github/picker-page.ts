import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import type { GitHubPullRequests } from "./pull-requests.ts";
import { graphErrors } from "./read-scope.ts";

const Ref = Schema.Struct({ ref: Schema.String });

const Pull = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  draft: Schema.optional(Schema.Boolean),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  head: Ref,
  base: Schema.Struct({ ref: Schema.String, repo: Schema.Struct({ id: Schema.Number }) }),
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  updated_at: Schema.String,
});

const Mine = Schema.Struct({
  data: Schema.Struct({
    search: Schema.Struct({
      pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
      nodes: Schema.Array(
        Schema.Struct({
          number: Schema.Number,
          title: Schema.String,
          state: Schema.String,
          isDraft: Schema.Boolean,
          headRefName: Schema.String,
          baseRefName: Schema.String,
          updatedAt: Schema.String,
          author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
          repository: Schema.Struct({ databaseId: Schema.Number }),
        }),
      ),
    }),
  }),
});

const MINE_QUERY = `query CanopyPickerAuthor($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 30, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number title state isDraft headRefName baseRefName updatedAt author { login } repository { databaseId } } }
  }
  rateLimit { cost remaining resetAt }
}`;

export interface PickerPage {
  items: github.RepositoryPullRequest[];
  next: string;
}

export interface PickerSource {
  account: string;
  repository: string;
  repositoryId: string;
  branch: string;
  login: string;
  all: boolean;
}

/** A bounded upstream page. The shared client owns TTL, ETags, single-flight and account budgets. */
export async function pickerPage(
  prs: GitHubPullRequests,
  source: PickerSource,
  lane: number,
  position: string,
): Promise<PickerPage> {
  if (lane < 2) return priorityPage(prs, source, lane, position);
  const page = Number(position || "1");

  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000)
    throw new ConnectError("Refresh the pull request list.", Code.InvalidArgument);
  const path = `/repos/${source.repository}/pulls`;

  const params = new URLSearchParams({
    state: source.all ? "all" : "open",
    sort: "updated",
    direction: "desc",
    per_page: "30",
    page: String(page),
  });

  const result = await prs.client.read(source.account, {
    key: `picker:${source.repositoryId}:${params}`,
    path: `${path}?${params}`,
    ttl: 30_000,
    project: async (value, headers) => {
      const items = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Pull) }))(value).items.slice(0, 30);

      if (items.some((pr) => String(pr.base.repo.id) !== source.repositoryId))
        throw new ConnectError("Repository access changed. Refresh the list.", Code.PermissionDenied);

      const next = headers
        .get("link")
        ?.split(",")
        .find((entry) => /;\s*rel="next"/.test(entry));

      const href = next && /<([^>]+)>/.exec(next)?.[1];
      const url = href ? new URL(href) : undefined;

      const hasMore =
        url?.origin === "https://api.github.com" &&
        url.pathname === path &&
        Number(url.searchParams.get("page")) === page + 1;

      return Schema.decodeUnknownSync(Schema.JsonObject)({ items, next: hasMore ? String(page + 1) : "" });
    },
  });

  const value = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Pull), next: Schema.String }))(
    result.payload,
  );

  return {
    next: value.next,
    items: value.items.map((pr) =>
      create(github.RepositoryPullRequestSchema, {
        number: pr.number,
        title: pr.title,
        state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open",
        headRef: pr.head.ref,
        baseRef: pr.base.ref,
        author: pr.user?.login ?? "",
        updatedAt: timestampFromDate(new Date(pr.updated_at)),
      }),
    ),
  };
}

async function priorityPage(
  prs: GitHubPullRequests,
  source: PickerSource,
  lane: number,
  position: string,
): Promise<PickerPage> {
  if (lane === 0 && !source.branch) return { items: [], next: "" };
  const q = `repo:${source.repository} is:pr author:${source.login}${source.all ? "" : " is:open"} sort:updated-desc`;

  const result = await prs.client.read(source.account, {
    key: `picker-priority:${source.repositoryId}:${lane}:${lane === 0 ? source.branch : source.login}:${source.all}:${position}`,
    path: "/graphql",
    query: lane === 0 ? branchQuery(source.all) : MINE_QUERY,
    variables:
      lane === 0
        ? {
            owner: source.repository.split("/")[0]!,
            name: source.repository.split("/")[1]!,
            branch: source.branch,
            ...(position && { after: position }),
          }
        : { q, ...(position && { after: position }) },
    ttl: 30_000,
    project: async (value) => {
      if (graphErrors(value)) throw new ConnectError("Could not load pull requests. Retry the list.", Code.Unavailable);

      if (lane !== 0) return value;

      const repository = Schema.decodeUnknownSync(
        Schema.Struct({
          data: Schema.Struct({ repository: Schema.Struct({ databaseId: Schema.Number, pulls: Schema.JsonObject }) }),
        }),
      )(value).data.repository;

      if (String(repository.databaseId) !== source.repositoryId)
        throw new ConnectError("Repository access changed. Refresh the list.", Code.PermissionDenied);

      return { data: { search: repository.pulls } };
    },
  });

  const payload = Schema.decodeUnknownSync(Schema.JsonObject)(result.payload);

  if (graphErrors(payload))
    throw new ConnectError("Could not load your pull requests. Retry the list.", Code.Unavailable);
  const value = Schema.decodeUnknownSync(Mine)(payload).data.search;

  if (value.nodes.some((pr) => String(pr.repository.databaseId) !== source.repositoryId))
    throw new ConnectError("Repository access changed. Refresh the list.", Code.PermissionDenied);

  return {
    next: value.pageInfo.hasNextPage ? (value.pageInfo.endCursor ?? "") : "",
    items: value.nodes.map((pr) =>
      create(github.RepositoryPullRequestSchema, {
        number: pr.number,
        title: pr.title,
        state: graphState(pr.state, pr.isDraft),
        headRef: pr.headRefName,
        baseRef: pr.baseRefName,
        author: pr.author?.login ?? "",
        updatedAt: timestampFromDate(new Date(pr.updatedAt)),
      }),
    ),
  };
}

function graphState(state: string, draft: boolean) {
  if (state === "MERGED") return "merged";

  if (state === "CLOSED") return "closed";

  return draft ? "draft" : "open";
}

function branchQuery(all: boolean) {
  return `query CanopyPickerBranch($owner: String!, $name: String!, $branch: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      databaseId
      pulls: pullRequests(headRefName: $branch, states: ${all ? "[OPEN, CLOSED, MERGED]" : "[OPEN]"}, orderBy: {field: UPDATED_AT, direction: DESC}, first: 30, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { number title state isDraft headRefName baseRefName updatedAt author { login } repository { databaseId } }
      }
    }
    rateLimit { cost remaining resetAt }
  }`;
}
