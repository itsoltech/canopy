import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { reviewerLook } from "@canopy/domain/github-pr";
import { useColors, useTypography } from "../../ui/theme";
import { GitHubAvatar } from "./GitHubAvatar";
import { PullRequestStatusLook } from "./PullRequestStatus";
import { StatusIcon } from "./StatusIcon";
import { useState } from "react";
import { MetadataEdit } from "./MetadataEdit";

export function PullRequestPeople({ snapshot }: { snapshot: github.PullRequestSnapshot }) {
  const c = useColors();
  const type = useTypography();
  const [reviewerDisplay, setReviewers] = useState<github.PullRequestMetadata>();
  const [assigneeDisplay, setAssignees] = useState<github.PullRequestMetadata>();

  const reviewers = reviewerDisplay
    ? reviewerDisplay.reviewers.map((r) => ({ login: r.name, state: "requested" }))
    : snapshot.reviewers;

  const assignees = assigneeDisplay ? assigneeDisplay.assignees.map((a) => a.name) : snapshot.assignees;

  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={[type.meta, { color: c.muted }]}>Reviewers</Text>
          <MetadataEdit snapshot={snapshot} kind="reviewers" onDisplay={setReviewers} />
        </View>
        {!reviewers.length && <Text style={[type.small, { color: c.muted }]}>No reviewers requested</Text>}
        {reviewers.map((r, i) => (
          <View key={`${r.login}:${i}`} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 }}>
            <GitHubAvatar login={r.login} userId="" compact />
            <Text numberOfLines={1} style={[type.small, { flex: 1, color: c.text }]}>
              {r.login}
            </Text>
            <PullRequestStatusLook look={reviewerLook(r.state)} iconOnly />
          </View>
        ))}
      </View>
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={[type.meta, { color: c.muted }]}>Assignees</Text>
          <MetadataEdit snapshot={snapshot} kind="assignees" onDisplay={setAssignees} />
        </View>
        {!assignees.length && <Text style={[type.small, { color: c.muted }]}>No assignees</Text>}
        {assignees.map((login, i) => (
          <View key={`${login}:${i}`} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 }}>
            <GitHubAvatar {...{ login }} userId="" compact />
            <Text numberOfLines={1} style={[type.small, { flex: 1, color: c.text }]}>
              {login}
            </Text>
            <StatusIcon name="user" label="Assigned" />
          </View>
        ))}
      </View>
    </View>
  );
}
