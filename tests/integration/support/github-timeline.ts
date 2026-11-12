export const timelineActor = { login: "payload-actor" };
export const timelineDate = "2026-11-10T12:00:00Z";

export const timelineNoise = [
  ...["MentionedEvent", "SubscribedEvent", "UnsubscribedEvent"].flatMap((kind, index) => [
    { __typename: kind },
    { __typename: kind, id: `NOISE_${index}`, actor: timelineActor, createdAt: timelineDate },
  ]),
  { __typename: "UnsupportedEvent" },
];

export function timelineEventPage(older: boolean) {
  return {
    data: {
      repository: {
        pullRequest: {
          id: "PR_fixture_42",
          timelineItems: {
            nodes: older
              ? [
                  {
                    __typename: "LabeledEvent",
                    id: "LABEL",
                    actor: timelineActor,
                    createdAt: timelineDate,
                    label: { name: "security" },
                  },
                  { __typename: "IssueComment", id: "UNDATED", author: timelineActor, body: "Keep this comment" },
                ]
              : timelineNoise,
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
