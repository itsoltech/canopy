import { useState } from "react";
import { Image, Text, View } from "react-native";
import { useColors, useTypography } from "../../ui/theme";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import type { github } from "@canopy/contracts";

export function GitHubAvatar({
  login,
  url = "",
  pullRequestId = "",
  accountId = "",
  compact = false,
}: {
  login: string;
  url?: string;
  pullRequestId?: string;
  accountId?: string;
  compact?: boolean;
}) {
  const { client } = useSession();

  const read = useSharedQuery<github.PullRequestAvatar>(
    `GitHubAvatar:${pullRequestId}:${accountId}:${url}`,
    () => client!.api.getPullRequestAvatar({ pullRequestId, url, accountId }),
    !!client && ((!!url && !!pullRequestId) || !!accountId),
    86_400_000,
  );

  const c = useColors();
  const type = useTypography();
  const [failed, setFailed] = useState("");
  const source = read.data?.dataUrl ?? "";
  const size = compact ? 22 : 32;

  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        borderRadius: 16,
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: c.inset,
      }}
    >
      {(!source || failed === source) && (
        <Text style={[type.meta, { color: c.text, fontSize: compact ? 10 : type.meta.fontSize }]}>
          {login.slice(0, 2).toUpperCase()}
        </Text>
      )}
      {!!source && failed !== source && (
        <Image
          source={{ uri: source }}
          onError={() => setFailed(source)}
          style={{ position: "absolute", width: size, height: size }}
        />
      )}
    </View>
  );
}
