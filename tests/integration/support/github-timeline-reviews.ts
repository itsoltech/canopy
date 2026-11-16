const actor = { login: "fixture-reviewer", __typename: "User" };
const date = (day: number) => `2026-11-${String(day).padStart(2, "0")}T12:00:00Z`;
const pageInfo = { hasNextPage: false, endCursor: null };

function review(id: string, created: number, submitted: number | null, state = "COMMENTED") {
  return {
    __typename: "PullRequestReview",
    id,
    author: actor,
    body: "",
    createdAt: date(created),
    submittedAt: submitted === null ? null : date(submitted),
    state,
  };
}

function comment(id: string, reviewId: string | null | undefined) {
  const pullRequestReview = reviewId === undefined || reviewId === null ? reviewId : { id: reviewId };

  return {
    id,
    author: actor,
    body: `Inline comment ${id}`,
    url: `https://github.com/itsoltech/canopy/pull/42#discussion_${id}`,
    createdAt: date(9),
    originalCommit: { oid: "a".repeat(40) },
    pullRequestReview,
  };
}

function thread(id: string, reviewId: string | null | undefined) {
  return {
    id,
    path: "src/safe.ts",
    line: 9,
    isResolved: false,
    isOutdated: false,
    pullRequest: { id: "PR_fixture_42" },
    comments: { nodes: [comment(`${id}_ROOT`, reviewId)], pageInfo },
  };
}

export function timelineReviews(older: boolean) {
  return {
    data: {
      repository: {
        pullRequest: {
          id: "PR_fixture_42",
          timelineItems: {
            nodes: older
              ? [review("R3", 6, 6), review("R4", 7, 7)]
              : [
                  review("R1", 9, 12),
                  review("R2", 9, 11),
                  review("APPROVED", 13, null, "APPROVED"),
                  review("CHANGES", 14, 14, "CHANGES_REQUESTED"),
                ],
            pageInfo: {
              hasNextPage: older,
              hasPreviousPage: !older,
              startCursor: older ? "start" : "older",
              endCursor: older ? "older" : "end",
            },
          },
        },
      },
    },
  };
}

export function reviewConversations(replies: boolean) {
  const first = thread("T1", "R1");
  // A reply belongs to a different review; the root alone determines grouping.
  first.comments.nodes.push(comment("T1_REPLY", "R2"));

  if (replies) {
    first.comments.nodes = first.comments.nodes.slice(1);

    return { data: { node: first } };
  }

  return {
    data: {
      repository: {
        pullRequest: {
          id: "PR_fixture_42",
          reviewThreads: {
            nodes: [
              first,
              thread("T2", "R2"),
              thread("T3", "R3"),
              thread("T4", "R4"),
              thread("UNKNOWN", "NOT_LOADED"),
              thread("NULL", null),
              thread("MISSING", undefined),
            ],
            pageInfo,
          },
        },
      },
    },
  };
}
