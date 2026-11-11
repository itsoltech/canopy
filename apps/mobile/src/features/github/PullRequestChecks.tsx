import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as Linking from "expo-linking";
import { safeHref } from "@canopy/domain/markdown";
import { checkLook, checksSummary, sortedChecks } from "@canopy/domain/github-pr";
import type { github } from "@canopy/contracts";
import { Button, Notice } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { useColors, useTypography } from "../../ui/theme";
import { toneColor } from "./presentation";

export function PullRequestChecks({ snapshot }: { snapshot: github.PullRequestSnapshot }) {
  const c = useColors();
  const type = useTypography();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const checks = sortedChecks(snapshot.checks);

  async function open(url: string) {
    const href = safeHref(url);

    if (!href) return;

    try {
      await Linking.openURL(href);
      setError("");
    } catch {
      setError("Could not open this check. Open the pull request on GitHub.");
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text accessibilityRole="header" style={[type.small, { color: c.text }]}>
          {checksSummary(snapshot)}
        </Text>
        <Text style={[type.meta, { color: c.muted }]}>{snapshot.summary?.headSha.slice(0, 7)}</Text>
      </View>
      <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: 8, overflow: "hidden" }}>
        {(expanded ? checks : checks.slice(0, 5)).map((check, i) => {
          const look = checkLook(check.state);

          return (
            <Pressable
              key={`${check.name}:${i}`}
              accessibilityRole="link"
              accessibilityLabel={`${check.name}, ${check.provider}, ${look.label}`}
              disabled={!safeHref(check.url)}
              onPress={() => void open(check.url)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                minHeight: 48,
                paddingHorizontal: 10,
                borderTopWidth: i ? 1 : 0,
                borderTopColor: c.rule,
                backgroundColor: pressed ? c.pressed : undefined,
              })}
            >
              <Icon name={look.icon} color={toneColor(c, look.tone)} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={[type.small, { color: c.text }]}>
                  {check.name}
                </Text>
                <Text numberOfLines={1} style={[type.meta, { color: c.muted }]}>
                  {check.provider}
                </Text>
              </View>
              <Text style={[type.meta, { width: 76, textAlign: "right", color: toneColor(c, look.tone) }]}>
                {look.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {checks.length > 5 && (
        <Button
          variant="ghost"
          size="sm"
          title={expanded ? "Show fewer checks" : `Show ${checks.length - 5} more checks`}
          onPress={() => setExpanded(!expanded)}
        />
      )}
      {!!error && <Notice error>{error}</Notice>}
    </View>
  );
}
