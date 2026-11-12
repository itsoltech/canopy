import { View } from "react-native";
import type { Activity } from "@canopy/domain/github-read";
import { useColors } from "../../ui/theme";
import { GitHubAvatar } from "./GitHubAvatar";
import { ReviewThread } from "./ReviewThread";
import { TimelineEvent } from "./TimelineEvent";
import type { github } from "@canopy/contracts";

export function ActivityRow({
  id,
  row,
  snapshot,
}: {
  id: string;
  row: Activity;
  snapshot: github.PullRequestSnapshot;
}) {
  const c = useColors();
  const actor = row.kind === "thread" ? row.thread.comments[0] : row.items[0]?.content.value;

  return (
    <View style={{ flexDirection: "row", gap: 12, paddingTop: 16 }}>
      <View style={{ width: 32, alignItems: "center" }}>
        <View style={{ position: "absolute", top: 32, bottom: -16, width: 1, backgroundColor: c.line }} />
        <GitHubAvatar pullRequestId={id} url={actor?.avatarUrl} login={actor?.author || "GH"} />
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingTop: 6 }}>
        {row.kind === "thread" ? (
          <ReviewThread id={id} snapshot={snapshot} thread={row.thread} />
        ) : (
          <TimelineEvent snapshot={snapshot} items={row.items} />
        )}
      </View>
    </View>
  );
}
