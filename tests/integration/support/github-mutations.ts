import { Schema } from "effect";
import { readFixture, readHead, readBase, fixtureFilePath } from "./github-read.ts";

interface Comment {
  id: string;
  body: string;
  user: number;
  review: boolean;
  pr: string;
}

const fields = Schema.Struct({
  resource: Schema.optional(Schema.String),
  after: Schema.optional(Schema.String),
  input: Schema.optional(
    Schema.Struct({
      subjectId: Schema.optional(Schema.String),
      pullRequestReviewThreadId: Schema.optional(Schema.String),
      pullRequestReviewCommentId: Schema.optional(Schema.String),
      id: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
      pullRequestId: Schema.optional(Schema.String),
      path: Schema.optional(Schema.String),
      clientMutationId: Schema.optional(Schema.String),
    }),
  ),
});

export const fixturePath = fixtureFilePath;

export function mutationFixture(
  hooks: {
    graph?: Parameters<typeof readFixture>[0];
    rest?: Parameters<typeof readFixture>[1];
  } = {},
) {
  let head = readHead;
  let allowed = true;
  let reject = false;
  let lost = false;
  let writes = 0;
  let beforeMutation = () => {};

  const comments = new Map<string, Comment>([
    ["OWN", { id: "OWN", body: "Own **comment**", user: 101, review: false, pr: "PR_fixture_42" }],
    ["OTHER", { id: "OTHER", body: "Other comment", user: 102, review: false, pr: "PR_fixture_42" }],
    ["FOREIGN", { id: "FOREIGN", body: "Foreign PR", user: 101, review: false, pr: "PR_fixture_43" }],
    ["REVIEW_OWN", { id: "REVIEW_OWN", body: "Own review comment", user: 101, review: true, pr: "PR_fixture_42" }],
  ]);

  const viewed = new Map<string, string>();

  const viewState = (user: number, path: string) =>
    viewed.get(`${user}:${path}`) ??
    (path === fixturePath(1) ? "VIEWED" : path === fixturePath(2) ? "DISMISSED" : "UNVIEWED");

  const author = (user: number) => ({ login: `account-${user}`, databaseId: user });

  const node = (c: Comment, user: number) => ({
    id: c.id,
    body: c.body,
    author: author(c.user),
    viewerCanUpdate: true,
    viewerCanDelete: true,
    viewerDidAuthor: c.user === user,
    createdAt: "2026-11-10T12:00:00Z",
    url: "https://github.com/itsoltech/canopy/pull/42",
    originalCommit: { oid: head },
  });

  const thread = (user: number) => ({
    id: "THREAD_OWN",
    path: fixturePath(0),
    line: 1,
    isResolved: false,
    isOutdated: false,
    pullRequest: { id: "PR_fixture_42" },
    comments: {
      nodes: [...comments.values()].flatMap((c) => (c.review ? [node(c, user)] : [])),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });

  const fixture = readFixture(async (query, variables, user) => {
    const extra = await hooks.graph?.(query, variables, user);

    if (extra) return extra;
    const v = Schema.decodeUnknownSync(fields)(variables);

    const result = (value: Schema.JsonObject) =>
      Response.json({ data: { ...value, rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-11-11T00:00:00Z" } } });

    if (query.includes("CanopyMutationPreflight")) {
      const c = comments.get(v.resource ?? "");

      const target = c
        ? {
            __typename: c.review ? "PullRequestReviewComment" : "IssueComment",
            ...node(c, user),
            pullRequest: { id: c.pr },
          }
        : {
            __typename: "PullRequestReviewThread",
            id: v.resource ?? "",
            pullRequest: { id: v.resource === "THREAD_OWN" ? "PR_fixture_42" : "PR_fixture_43" },
          };

      return result({
        repository: {
          databaseId: 777,
          viewerPermission: allowed ? "WRITE" : null,
          pullRequest: { id: "PR_fixture_42", headRefOid: head, state: "OPEN", isDraft: false },
        },
        node: target,
      });
    }

    if (query.includes("CanopyViewed")) {
      const start = Number(v.after ?? 0);

      return result({
        repository: {
          pullRequest: {
            id: "PR_fixture_42",
            headRefOid: head,
            baseRefOid: readBase,
            files: {
              nodes: Array.from({ length: 100 }, (_, n) => ({
                path: fixturePath(start + n),
                viewerViewedState: viewState(user, fixturePath(start + n)),
              })),
              pageInfo: { hasNextPage: start + 100 < 300, endCursor: String(start + 100) },
            },
          },
        },
      });
    }

    if (query.includes("CanopyTimeline"))
      return result({
        repository: {
          pullRequest: {
            id: "PR_fixture_42",
            timelineItems: {
              nodes: [...comments.values()].flatMap((c) =>
                !c.review && c.pr === "PR_fixture_42" ? [{ __typename: "IssueComment", ...node(c, user) }] : [],
              ),
              pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null },
            },
          },
        },
      });

    if (query.includes("CanopyReviewThreads"))
      return result({
        repository: {
          pullRequest: {
            id: "PR_fixture_42",
            reviewThreads: { nodes: [thread(user)], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      });

    if (query.includes("CanopyReviewReplies")) return result({ node: thread(user) });

    if (!query.startsWith("mutation ")) return;
    writes++;
    beforeMutation();

    if (reject || !allowed) return Response.json({ data: { result: null }, errors: [{ type: "FORBIDDEN" }] });
    const input = v.input;

    if (!input) throw new Error("Fixture mutation requires input");

    if (query.includes("CanopyMarkViewed") || query.includes("CanopyUnmarkViewed")) {
      if (!Array.from({ length: 300 }, (_, i) => fixturePath(i)).includes(input.path ?? ""))
        return Response.json({ data: { result: null }, errors: [{ type: "NOT_FOUND" }] });
      viewed.set(`${user}:${input.path}`, query.includes("CanopyMarkViewed") ? "VIEWED" : "UNVIEWED");

      return result({ result: { pullRequest: { id: "PR_fixture_42" } } });
    }

    if (query.includes("CanopyDelete")) {
      comments.delete(input.id ?? "");

      return result({ result: { clientMutationId: input.clientMutationId ?? "" } });
    }

    if (query.includes("CanopyUpdate")) {
      const c = comments.get(input.id ?? input.pullRequestReviewCommentId ?? "");

      if (!c) throw new Error("Fixture comment missing");
      c.body = input.body ?? "";

      return result({ result: { [c.review ? "pullRequestReviewComment" : "issueComment"]: { id: c.id } } });
    }

    const id = `CREATED_${writes}`;
    const review = query.includes("CanopyReply");
    comments.set(id, { id, body: input.body ?? "", user, review, pr: "PR_fixture_42" });

    return result({ result: { [review ? "comment" : "node"]: { id } } });
  }, hooks.rest);

  const original = fixture.options.fetch!;

  const fixtureFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await original(input, init);

      if (lost && String(init?.body).includes('"query":"mutation ')) {
        lost = false;
        throw new TypeError("Fixture lost response after send");
      }

      return response;
    },
    { preconnect: fetch.preconnect },
  );

  return {
    ...fixture,
    options: { ...fixture.options, fetch: fixtureFetch },
    comments,
    viewState,
    head: (value: string) => {
      head = value;
      fixture.head(value);
    },
    allowed: (value: boolean) => {
      allowed = value;
    },
    reject: (value: boolean) => {
      reject = value;
    },
    loseResponse: () => {
      lost = true;
    },
    beforeMutation: (value: () => void) => {
      beforeMutation = value;
    },
    get writes() {
      return writes;
    },
  };
}
