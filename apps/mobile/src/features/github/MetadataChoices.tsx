import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { labelColors } from "@canopy/domain/github-pr";
import { Field } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { useColors, useTypography } from "../../ui/theme";
import { GitHubAvatar } from "./GitHubAvatar";
import type { MetadataKind } from "@canopy/domain/github-metadata";
import { ReRequestReview } from "./ReRequestReview";

export function MetadataChoices({
  options,
  kind,
  snapshot,
  ids,
  disabled,
  onToggle,
}: {
  options: github.PullRequestMetadataOption[];
  kind: MetadataKind;
  snapshot: github.PullRequestSnapshot;
  ids: string[];
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  const c = useColors(),
    type = useTypography();

  const [query, setQuery] = useState("");
  const shown = options.filter((o) => o.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <View style={{ gap: 8 }}>
      <Field
        label="Search choices"
        placeholder={
          kind === "labels" ? "Search labels" : kind === "reviewers" ? "Search people or teams" : "Search people"
        }
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
      />
      {shown.map((option) => {
        const colors = labelColors(option.color);

        return (
          <View key={option.id} style={{ flexDirection: "row", alignItems: "center" }}>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel={option.name}
              accessibilityState={{ checked: ids.includes(option.id), disabled }}
              disabled={disabled}
              onPress={() => onToggle(option.id)}
              style={({ pressed }) => ({
                minHeight: 48,
                flex: 1,
                minWidth: 0,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 8,
                borderRadius: 6,
                backgroundColor: pressed ? c.pressed : "transparent",
                opacity: disabled ? 0.5 : 1,
              })}
            >
              {option.kind === "label" ? (
                <View
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    borderWidth: 1,
                    borderColor: c.line,
                    backgroundColor: colors.background,
                  }}
                />
              ) : option.kind === "team" ? (
                <Icon name="user-group" label="Team" />
              ) : (
                <GitHubAvatar
                  login={option.name}
                  pullRequestId={snapshot.summary?.ref?.id}
                  url={option.avatarUrl}
                  compact
                />
              )}
              <Text numberOfLines={1} style={[type.small, { flex: 1, color: c.text }]}>
                {option.name}
              </Text>
              <View style={{ width: 20 }}>{ids.includes(option.id) && <Icon name="check" color={c.accent} />}</View>
            </Pressable>
            {kind === "reviewers" &&
              snapshot.reviewers.some((r) => r.nodeId === option.id && r.state !== "requested") && (
                <ReRequestReview snapshot={snapshot} id={option.id} />
              )}
          </View>
        );
      })}
      {!shown.length && <Text style={[type.meta, { color: c.muted }]}>No matching choices</Text>}
    </View>
  );
}
