import { useState } from "react";
import { Text, View } from "react-native";
import * as Linking from "expo-linking";
import { safeHref } from "@canopy/domain/markdown";
import type { github } from "@canopy/contracts";
import { Button, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";

export function PullRequestChecks({ snapshot }: { snapshot: github.PullRequestSnapshot }) {
  const c = useColors();
  const [error, setError] = useState("");

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
    <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: c.line, paddingTop: 16 }}>
      <Text accessibilityRole="header" style={[styles.label, { color: c.text }]}>
        Checks · {snapshot.summary?.checksState || "unavailable"}
      </Text>
      <Text selectable style={[styles.meta, { color: c.muted }]}>
        {snapshot.summary?.headSha}
      </Text>
      {snapshot.checks.length ? (
        snapshot.checks.map((check, i) => (
          <View
            key={`${check.name}:${i}`}
            style={{ gap: 6, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line }}
          >
            <Text style={[styles.label, { color: c.text }]}>{check.name}</Text>
            <Text style={[styles.body, { color: c.text }]}>
              {check.state.replaceAll("_", " ")} · {check.provider}
            </Text>
            {!!safeHref(check.url) && <Button size="sm" title="Open check" onPress={() => void open(check.url)} />}
          </View>
        ))
      ) : (
        <Text style={[styles.body, { color: c.muted }]}>No checks available</Text>
      )}
      {!!error && <Notice error>{error}</Notice>}
    </View>
  );
}
