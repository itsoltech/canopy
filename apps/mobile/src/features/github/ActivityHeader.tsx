import { Pressable, Text, View } from "react-native";
import * as Linking from "expo-linking";
import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import type { PullRequestLook } from "@canopy/domain/github-pr";
import { formatAge } from "@canopy/domain/format";
import { safeHref } from "@canopy/domain/markdown";
import { useColors, useTypography } from "../../ui/theme";
import { toast } from "../../ui/Toast";
import { StatusIcon } from "./StatusIcon";
import { toneColor } from "./presentation";
import { GitHubAvatar } from "./GitHubAvatar";

export function ActivityHeader({
  author,
  look,
  time,
  url = "",
  avatarUrl = "",
  pullRequestId = "",
  withAvatar = false,
}: {
  author: string;
  look: PullRequestLook;
  time?: Timestamp | undefined;
  url?: string;
  avatarUrl?: string;
  pullRequestId?: string;
  withAvatar?: boolean;
}) {
  const c = useColors();
  const type = useTypography();
  const age = formatAge(time);
  const absolute = time ? timestampDate(time).toLocaleString() : "Time unavailable";
  const href = safeHref(url);

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {withAvatar && <GitHubAvatar login={author} url={avatarUrl} pullRequestId={pullRequestId} compact />}
      <Text numberOfLines={1} style={[type.small, { flexShrink: 1, color: c.text }]}>
        {author || "GitHub"}
      </Text>
      <StatusIcon name={look.icon} label={look.label} color={toneColor(c, look.tone)} />
      {!!age && (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${age === "now" ? "Now" : `${age} ago`}. ${absolute}`}
          onLongPress={() => toast(absolute)}
          onPress={() => {
            if (href) void Linking.openURL(href);
          }}
          hitSlop={8}
          style={{ marginLeft: "auto" }}
        >
          <Text style={[type.meta, { color: c.muted }]}>{age === "now" ? "now" : `${age} ago`}</Text>
        </Pressable>
      )}
    </View>
  );
}
