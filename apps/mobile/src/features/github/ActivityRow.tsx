import { View } from "react-native";
import type { Activity } from "@canopy/domain/github-read";
import { useColors } from "../../ui/theme";
import { GitHubAvatar } from "./GitHubAvatar";
import { ReviewThread } from "./ReviewThread";
import { TimelineEvent } from "./TimelineEvent";

export function ActivityRow({ id, row }: { id: string; row: Activity }) {
  const c = useColors();
  const author = row.kind === "thread" ? row.thread.comments[0]?.author : row.items[0]?.content.value?.author;

  return (
    <View style={{ flexDirection: "row", gap: 12, paddingTop: 16 }}>
      <View style={{ width: 32, alignItems: "center" }}>
        <View style={{ position: "absolute", top: 32, bottom: -16, width: 1, backgroundColor: c.line }} />
        <GitHubAvatar userId="" login={author || "GH"} />
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingTop: 6 }}>
        {row.kind === "thread" ? <ReviewThread id={id} thread={row.thread} /> : <TimelineEvent items={row.items} />}
      </View>
    </View>
  );
}
