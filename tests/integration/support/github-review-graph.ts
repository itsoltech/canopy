import { Schema } from "effect";
import {
  ReviewState,
  anchor,
  reviewPr as pr,
  reviewDate as date,
  reviewResult as result,
  reviewDenied as denied,
  userActor,
} from "./github-review-state.ts";

const input = Schema.Struct({
  resource: Schema.optional(Schema.String),
  login: Schema.optional(Schema.String),
  after: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  reply: Schema.optional(Schema.String),
  input: Schema.optional(
    Schema.Struct({
      ...anchor.fields,
      path: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
      side: Schema.optional(Schema.String),
      line: Schema.optional(Schema.Number),
      pullRequestReviewId: Schema.optional(Schema.String),
      pullRequestReviewCommentId: Schema.optional(Schema.String),
      pullRequestId: Schema.optional(Schema.String),
      id: Schema.optional(Schema.String),
      threadId: Schema.optional(Schema.String),
      commitOID: Schema.optional(Schema.String),
      event: Schema.optional(Schema.String),
      threads: Schema.optional(Schema.Array(anchor)),
      clientMutationId: Schema.optional(Schema.String),
    }),
  ),
});

type Input = NonNullable<typeof input.Type.input>;

export class ReviewGraph extends ReviewState {
  graph(query: string, variables: Schema.JsonObject, user: number) {
    const v = Schema.decodeUnknownSync(input)(variables);

    if (query.includes("CanopyReviewDraft")) {
      const r = this.pending(user);

      return result({
        repository: {
          databaseId: 777,
          pullRequest: {
            id: pr,
            headRefOid: this.head,
            author: userActor(this.author),
            reviews: {
              nodes: r
                ? [
                    {
                      id: r.id,
                      fullDatabaseId: r.databaseId,
                      body: r.body,
                      updatedAt: `${date}:${r.version}`,
                      author: userActor(r.user),
                      commit: { oid: r.sha },
                      comments: { totalCount: r.comments.length },
                    },
                  ]
                : [],
            },
          },
        },
      });
    }

    if (query.includes("CanopyMutationPreflight")) return this.preflight(v.resource ?? "", user);

    if (query.includes("CanopyReviewThreads")) {
      const all = [...this.threads.values()].filter(
        (t) => t.pr === pr && (t.review.state !== "PENDING" || t.review.user === user),
      );

      const start = Number(v.after ?? 0);

      return result({
        repository: {
          pullRequest: {
            id: pr,
            reviewThreads: {
              nodes: all.slice(start, start + 30).map((t) => this.thread(t, user)),
              pageInfo: { hasNextPage: start + 30 < all.length, endCursor: String(start + 30) },
            },
          },
        },
      });
    }

    if (query.includes("CanopyReviewReplies")) {
      const t = this.threads.get(v.id ?? "");

      return result({ node: t ? this.thread(t, user) : null });
    }

    if (query.startsWith("mutation ") && v.input) return this.mutate(query, v.input, user);

    return;
  }
  private preflight(resource: string, user: number) {
    const r = [...this.reviews.values()].find((r) => r.comments.some((c) => c.id === resource));

    const c = r?.comments.find((c) => c.id === resource),
      t = this.threads.get(resource);

    if (!c && !t && !this.reviews.has(resource) && resource !== pr) return;

    return result({
      repository: {
        databaseId: 777,
        viewerPermission: this.permitted ? "WRITE" : null,
        pullRequest: { id: pr, headRefOid: this.head, state: "OPEN", isDraft: false },
      },
      node:
        c && r
          ? { __typename: "PullRequestReviewComment", ...this.node(c, user), pullRequest: { id: r.pr } }
          : t
            ? { __typename: "PullRequestReviewThread", ...this.thread(t, user) }
            : { __typename: "PullRequestReview", id: resource, pullRequest: { id: pr } },
    });
  }
  private mutate(query: string, i: Input, user: number) {
    const owner = [...this.reviews.values()].find((r) =>
      r.comments.some((c) => c.id === (i.id ?? i.pullRequestReviewCommentId)),
    );

    if ((query.includes("CanopyUpdate") || query.includes("CanopyDeleteReviewComment")) && !owner) return;

    if (
      !/Canopy(AddReview|SubmitReview|DiscardReview|ResolveThread|UnresolveThread|UpdateReviewComment|DeleteReviewComment)/.test(
        query,
      )
    )
      return;
    this.mutations++;
    this.beforeSend();

    if (this.rejected || !this.permitted) return denied();

    if (query.includes("CanopyAddReviewThread")) {
      const r = this.reviews.get(i.pullRequestReviewId ?? "");

      if (!r || r.user !== user || r.state !== "PENDING") return denied("NOT_FOUND");

      return result({ result: { thread: { id: this.addComment(r, Schema.decodeUnknownSync(anchor)(i)).id } } });
    }

    if (query.includes("CanopyAddReview")) {
      if (this.pending(user)) return denied("UNPROCESSABLE");
      const r = this.seed(user, 0);
      r.sha = i.commitOID ?? this.head;
      r.state = i.event ?? "PENDING";
      r.body = i.body ?? "";

      for (const a of i.threads ?? []) this.addComment(r, a);

      return result({ result: { pullRequestReview: { id: r.id } } });
    }

    if (query.includes("CanopySubmitReview")) {
      const r = this.reviews.get(i.pullRequestReviewId ?? "");

      if (!r || r.user !== user || r.state !== "PENDING") return denied("NOT_FOUND");
      r.state = i.event ?? "COMMENT";
      r.body = i.body ?? "";
      r.version++;

      return result({ result: { pullRequestReview: { id: r.id } } });
    }

    if (query.includes("CanopyDiscardReview")) {
      const r = this.reviews.get(i.pullRequestReviewId ?? "");

      if (r) {
        this.reviews.delete(r.id);

        for (const [id, t] of this.threads) if (t.review === r) this.threads.delete(id);
      }

      return result({ result: { clientMutationId: i.clientMutationId ?? "" } });
    }

    if (query.includes("CanopyResolveThread") || query.includes("CanopyUnresolveThread")) {
      const t = this.threads.get(i.threadId ?? "");

      if (!t || !this.canResolve) return denied();
      t.resolved = query.includes("CanopyResolveThread");

      return result({ result: { thread: { id: t.id } } });
    }

    if (owner) {
      const id = i.id ?? i.pullRequestReviewCommentId;

      if (query.includes("CanopyUpdate")) {
        const c = owner.comments.find((c) => c.id === id)!;
        c.body = i.body ?? "";
        c.version++;
      } else {
        owner.comments = owner.comments.filter((c) => c.id !== id);

        for (const [tid, t] of this.threads) if (t.comment.id === id) this.threads.delete(tid);
      }

      owner.version++;

      return result({
        result: query.includes("CanopyUpdate")
          ? { pullRequestReviewComment: { id: id! } }
          : { clientMutationId: i.clientMutationId ?? "" },
      });
    }

    throw new Error("Unsupported fixture review mutation");
  }
}
