import { Schema } from "effect";
import { readHead } from "./github-read.ts";
import { fixturePath } from "./github-mutations.ts";

export const reviewPr = "PR_fixture_42",
  reviewDate = "2026-11-10T12:00:00Z";

export const anchor = Schema.Struct({
  path: Schema.String,
  body: Schema.String,
  side: Schema.String,
  line: Schema.Number,
  startSide: Schema.optional(Schema.String),
  startLine: Schema.optional(Schema.Number),
});

type Anchor = { -readonly [K in keyof typeof anchor.Type]: (typeof anchor.Type)[K] };

export interface ReviewComment extends Anchor {
  id: string;
  user: number;
  sha: string;
  version: number;
}

export interface Review {
  id: string;
  databaseId: string;
  pr: string;
  user: number;
  sha: string;
  body: string;
  state: string;
  comments: ReviewComment[];
  version: number;
}

export interface ReviewThread {
  id: string;
  pr: string;
  resolved: boolean;
  comment: ReviewComment;
  review: Review;
}

export const reviewResult = (value: Schema.JsonObject) =>
  Response.json({ data: { ...value, rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-11-11T00:00:00Z" } } });

export const userActor = (user: number) => ({ login: `account-${user}`, databaseId: user });
export const reviewDenied = (type = "FORBIDDEN") => Response.json({ data: { result: null }, errors: [{ type }] });

export class ReviewState {
  reviews = new Map<string, Review>();
  threads = new Map<string, ReviewThread>();
  head = readHead;
  author = 202;
  serial = 0;
  mutations = 0;
  permitted = true;
  rejected = false;
  canResolve = true;
  beforeSend = () => {};
  pending(user: number) {
    return [...this.reviews.values()].find((r) => r.user === user && r.state === "PENDING" && r.pr === reviewPr);
  }
  node(c: ReviewComment, user: number) {
    return {
      id: c.id,
      body: c.body,
      author: userActor(c.user),
      originalCommit: { oid: c.sha },
      createdAt: reviewDate,
      url: `https://github.com/itsoltech/canopy/pull/42#discussion_${c.id}`,
      viewerCanUpdate: true,
      viewerCanDelete: true,
      viewerDidAuthor: c.user === user,
      state: "PENDING",
    };
  }
  thread(t: ReviewThread, user: number) {
    return {
      id: t.id,
      path: t.comment.path,
      line: t.comment.sha === this.head ? t.comment.line : null,
      originalLine: t.comment.line,
      originalStartLine: t.comment.startLine ?? null,
      startLine: t.comment.startLine ?? null,
      diffSide: t.comment.side,
      startDiffSide: t.comment.startSide ?? null,
      isResolved: t.resolved,
      isOutdated: t.comment.sha !== this.head,
      viewerCanResolve: this.canResolve,
      viewerCanUnresolve: this.canResolve,
      pullRequest: { id: t.pr },
      comments: {
        nodes: [{ ...this.node(t.comment, user), state: t.review.state }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
  }
  addComment(r: Review, a: Anchor) {
    const c = { ...a, id: `REVIEW_COMMENT_${++this.serial}`, user: r.user, sha: r.sha, version: 0 };
    r.comments.push(c);
    r.version++;
    const t = { id: `REVIEW_THREAD_${this.serial}`, pr: r.pr, resolved: false, comment: c, review: r };
    this.threads.set(t.id, t);

    return t;
  }
  seed(user: number, count = 1, pull = reviewPr) {
    const r: Review = {
      id: `REVIEW_${++this.serial}`,
      databaseId: String(this.serial),
      pr: pull,
      user,
      sha: this.head,
      body: "",
      state: "PENDING",
      comments: [],
      version: 0,
    };

    this.reviews.set(r.id, r);

    for (let i = 0; i < count; i++)
      this.addComment(r, {
        path: fixturePath(0),
        body: `Pending finding ${i + 1}`,
        side: i % 2 ? "LEFT" : "RIGHT",
        line: 9,
        startLine: 8,
        startSide: i % 2 ? "LEFT" : "RIGHT",
      });

    return r;
  }
  rest(request: Request, user: number) {
    const url = new URL(request.url),
      match = /\/pulls\/42\/reviews\/(\d+)\/comments$/.exec(url.pathname);

    if (!match) return;
    const r = [...this.reviews.values()].find((r) => r.databaseId === match[1] && r.user === user);

    if (!r) return Response.json({}, { status: 404 });
    const start = (Number(url.searchParams.get("page") ?? 1) - 1) * 50;

    return Response.json(
      r.comments.slice(start, start + 50).map((c) => ({
        node_id: c.id,
        body: c.body,
        path: c.path,
        side: c.side,
        start_side: c.startSide ?? null,
        line: c.sha === this.head ? c.line : null,
        start_line: c.sha === this.head ? (c.startLine ?? null) : null,
        original_line: c.line,
        original_start_line: c.startLine ?? null,
        original_commit_id: c.sha,
        updated_at: `${reviewDate}:${c.version}`,
        created_at: reviewDate,
        html_url: "https://github.com/itsoltech/canopy/pull/42",
        user: { id: c.user, login: `account-${c.user}` },
      })),
      { headers: start + 50 < r.comments.length ? { link: '<https://api.github.com/fixed>; rel="next"' } : {} },
    );
  }
}
