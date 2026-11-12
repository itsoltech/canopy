import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { formatRelative } from "@canopy/domain/format";
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
      accessibilityLabel={`#${pr.number} ${pr.title}, ${pr.state}, ${pr.headRef} to ${pr.baseRef}, ${pr.author}${pr.linked ? ", linked" : ""}`}
      accessibilityState={{ disabled: disabled || pr.linked }}
      disabled={disabled || pr.linked}
      onPress={() => onSelect(pr)}
      style={({ pressed }) => ({
        minHeight: 64,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        padding: 8,
        borderRadius: 8,
        opacity: pr.linked ? 0.5 : 1,
        backgroundColor: pressed ? c.pressed : "transparent",
      })}
    >
      <PullRequestStatus state={pr.state} iconOnly style={{ paddingTop: 2 }} />
      <View style={{ minWidth: 0, flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={[styles.overlay, { color: c.text }]}>
          #{pr.number} {pr.title}
        </Text>
        <Text numberOfLines={1} style={[styles.overlayMeta, { color: c.muted }]}>
          {pr.headRef} → {pr.baseRef}
        </Text>
        <View style={{ minWidth: 0, flexDirection: "row", gap: 6 }}>
          <Text numberOfLines={1} style={[styles.overlayMeta, { color: c.muted, flexShrink: 1 }]}>
            {pr.author}
          </Text>
          {pr.updatedAt && <Text style={[styles.overlayMeta, { color: c.muted }]}>{formatRelative(pr.updatedAt)}</Text>}
        </View>
      </View>
      <View style={{ width: 88, gap: 2, alignItems: "flex-end" }}>
        {(pr.currentBranch || pr.viewerIsAuthor) && (
          <Text style={[styles.overlayMeta, { color: c.muted }]}>{pr.currentBranch ? "Current branch" : "Yours"}</Text>
        )}
        {pr.linked && <Text style={[styles.overlayMeta, { color: c.muted }]}>Linked</Text>}
      </View>
    </Pressable>
  );
});
