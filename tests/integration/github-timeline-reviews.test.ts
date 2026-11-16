import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { dockerAvailable } from "@canopy/db/testing";
import { pullRequestActivity } from "@canopy/domain/github-read";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";
import { linkedRead, readFixture } from "./support/github-read.ts";
import { reviewConversations, timelineReviews } from "./support/github-timeline-reviews.ts";

describe.skipIf(!dockerAvailable)("GitHub review timeline through gRPC", () => {
  const fixture = readFixture((query, variables) => {
    if (query.includes("query CanopyTimeline")) {
      expect(query).toContain("createdAt submittedAt state");

      return Response.json(timelineReviews(!!variables["before"]));
    }

    if (query.includes("query CanopyReviewThreads") || query.includes("query CanopyReviewReplies")) {
      expect(query).toContain("pullRequestReview{id}");

      return Response.json(reviewConversations(query.includes("query CanopyReviewReplies")));
    }

    return;
  });

  let gw: TestGateway;
  let pr: string;

  beforeAll(async () => {
    gw = await startTestGateway({ github: fixture.options });
    ({ pr } = await linkedRead(gw, fixture));
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture.close();
  });

  test("maps review identity on root comments and replies and uses submission dates with a creation fallback", async () => {
    const timeline = await gw.api.listPullRequestTimeline({ pullRequestId: pr });
    const reviews = new Map(timeline.items.map((item) => [item.content.value!.id, item.content.value!]));
    expect(reviews.get("R1")?.createdAt).toEqual(timestampFromDate(new Date("2026-11-12T12:00:00Z")));
    expect(reviews.get("R2")?.createdAt).toEqual(timestampFromDate(new Date("2026-11-11T12:00:00Z")));
    expect(reviews.get("APPROVED")?.createdAt).toEqual(timestampFromDate(new Date("2026-11-13T12:00:00Z")));
    expect(reviews.get("APPROVED")?.state).toBe("approved");
    expect(reviews.get("CHANGES")?.state).toBe("changes_requested");
    expect(timeline.items.every((item) => item.content.case === "review" && item.content.value.body === "")).toBe(true);
    const conversations = await gw.api.listPullRequestReviewThreads({ pullRequestId: pr });
    expect(conversations.threads[0]?.comments.map((comment) => comment.reviewId)).toEqual(["R1", "R2"]);
    expect(conversations.threads.find((thread) => thread.id === "NULL")?.comments[0]?.reviewId).toBe("");
    expect(conversations.threads.find((thread) => thread.id === "MISSING")?.comments[0]?.reviewId).toBe("");
    const replies = await gw.api.listPullRequestReviewThreads({ pullRequestId: pr, resourceId: "T1" });
    expect(replies.threads[0]?.comments[0]?.reviewId).toBe("R2");
  });

  test("groups by root review ID across pages, preserving empty verdicts and unmatched conversations", async () => {
    const latest = await gw.api.listPullRequestTimeline({ pullRequestId: pr });
    const conversations = await gw.api.listPullRequestReviewThreads({ pullRequestId: pr });
    const rows = pullRequestActivity(latest.items, conversations.threads, false);
    const events = rows.filter((row) => row.kind === "event");
    expect(events.map((row) => row.key)).toEqual(["CHANGES", "APPROVED", "R1", "R2"]);
    expect(events.map((row) => row.threads.map((thread) => thread.id))).toEqual([[], [], ["T1"], ["T2"]]);
    expect(rows.filter((row) => row.kind === "thread").map((row) => row.thread.id)).toEqual([
      "T3",
      "T4",
      "UNKNOWN",
      "NULL",
      "MISSING",
    ]);
    const older = await gw.api.listPullRequestTimeline({ pullRequestId: pr, cursor: latest.page!.nextCursor });
    const items = [...latest.items, ...older.items];
    const complete = pullRequestActivity(items, conversations.threads, true);
    const reviews = complete.filter((row) => row.kind === "event");
    expect(reviews.map((row) => row.key)).toEqual(["R3", "R4", "R2", "R1", "APPROVED", "CHANGES"]);
    expect(reviews.map((row) => row.threads.map((thread) => thread.id))).toEqual([
      ["T3"],
      ["T4"],
      ["T2"],
      ["T1"],
      [],
      [],
    ]);
    expect(complete.filter((row) => row.kind === "thread").map((row) => row.thread.id)).toEqual([
      "UNKNOWN",
      "NULL",
      "MISSING",
    ]);
    const onlyThreads = pullRequestActivity([], conversations.threads, false);
    expect(onlyThreads.every((row) => row.kind === "thread")).toBe(true);
    expect(onlyThreads).toHaveLength(conversations.threads.length);
  });
});
