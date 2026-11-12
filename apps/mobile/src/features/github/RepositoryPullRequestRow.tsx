import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { formatAge } from "@canopy/domain/format";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { PullRequestStatus } from "./PullRequestStatus";

export const RepositoryPullRequestRow = memo(function RepositoryPullRequestRow({
  pr,
  disabled,
  onSelect,
}: {
  pr: github.RepositoryPullRequest;
  disabled: boolean;
  onSelect: (pr: github.RepositoryPullRequest) => void;
}) {
  const c = useColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`#${pr.number} ${pr.title}, ${pr.state}, ${pr.headRef} to ${pr.baseRef}, ${pr.author}${pr.currentBranch ? ", current branch" : pr.viewerIsAuthor ? ", yours" : ""}${pr.linked ? ", linked" : ""}`}
      accessibilityState={{ disabled: disabled || pr.linked }}
      disabled={disabled || pr.linked}
      onPress={() => onSelect(pr)}
      style={({ pressed }) => ({
        minHeight: 48,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 8,
        opacity: pr.linked ? 0.5 : 1,
        backgroundColor: pressed ? c.pressed : "transparent",
      })}
    >
      <PullRequestStatus state={pr.state} iconOnly style={{ paddingTop: 2 }} />
      <View style={{ minWidth: 0, flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={[styles.overlay, { color: c.muted, fontVariant: ["tabular-nums"] }]}>#{pr.number}</Text>
          <Text numberOfLines={1} style={[styles.overlay, { color: c.text, flex: 1 }]}>
            {pr.title}
          </Text>
          <View style={{ width: 36, flexDirection: "row", justifyContent: "flex-end", gap: 4 }}>
            {pr.currentBranch ? (
              <Icon name="git-branch" label="Current branch" size={14} />
            ) : pr.viewerIsAuthor ? (
              <Icon name="user" label="Yours" size={14} />
            ) : null}
            {pr.linked && <Icon name="check" label="Linked" size={14} />}
          </View>
        </View>
        <View style={{ minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text numberOfLines={1} style={[styles.overlayMeta, { color: c.muted, flexShrink: 1 }]}>
            {pr.headRef} → {pr.baseRef}
          </Text>
          <Text style={[styles.overlayMeta, { color: c.muted }]}>·</Text>
          <Text numberOfLines={1} style={[styles.overlayMeta, { color: c.muted, maxWidth: 80 }]}>
            {pr.author}
          </Text>
          {!!pr.updatedAt && (
            <Text style={[styles.overlayMeta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
              · {formatAge(pr.updatedAt)}
            </Text>
          )}
        </View>
      </View>
    </Pressable>
  );
});
