import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { reviewerLook } from "@canopy/domain/github-pr";
import { useColors, useTypography } from "../../ui/theme";
import { GitHubAvatar } from "./GitHubAvatar";
import { PullRequestStatusLook } from "./PullRequestStatus";
import { Icon } from "../../ui/Icon";

export function PullRequestPeople({ snapshot }: { snapshot: github.PullRequestSnapshot }) {
  const c = useColors();
  const type = useTypography();

  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 4 }}>
        <Text style={[type.meta, { color: c.muted }]}>Reviewers</Text>
        {!snapshot.reviewers.length && <Text style={[type.small, { color: c.muted }]}>No reviewers requested</Text>}
        {snapshot.reviewers.map((r, i) => (
          <View key={`${r.login}:${i}`} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 }}>
            <GitHubAvatar login={r.login} userId="" compact />
            <Text numberOfLines={1} style={[type.small, { flex: 1, color: c.text }]}>
              {r.login}
            </Text>
            <PullRequestStatusLook look={reviewerLook(r.state)} />
          </View>
        ))}
      </View>
      {!!snapshot.assignees.length && (
        <View style={{ gap: 4 }}>
          <Text style={[type.meta, { color: c.muted }]}>Assignees</Text>
          {snapshot.assignees.map((login, i) => (
            <View key={`${login}:${i}`} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 }}>
              <GitHubAvatar {...{ login }} userId="" compact />
              <Text numberOfLines={1} style={[type.small, { flex: 1, color: c.text }]}>
                {login}
              </Text>
              <Icon name="user" />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
