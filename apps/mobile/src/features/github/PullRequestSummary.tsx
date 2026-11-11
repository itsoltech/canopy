import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { PullRequestChecks } from "./PullRequestChecks";
import { PullRequestLabels } from "./PullRequestLabels";
import { PullRequestPeople } from "./PullRequestPeople";
import { Markdown } from "../../ui/markdown/Markdown";
import { useColors, useTypography } from "../../ui/theme";

export function PullRequestSummary({ snapshot }: { snapshot: github.PullRequestSnapshot }) {
  const c = useColors();
  const type = useTypography();

  return (
    <View style={{ gap: 20, minWidth: 0 }}>
      <PullRequestPeople {...{ snapshot }} />
      <PullRequestLabels {...{ snapshot }} />
      <PullRequestChecks {...{ snapshot }} />
      <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: c.line, paddingTop: 16 }}>
        <Text accessibilityRole="header" style={[type.meta, { color: c.muted }]}>
          Description
        </Text>
        {snapshot.body ? (
          <Markdown text={snapshot.body} />
        ) : (
          <Text style={[type.small, { color: c.muted }]}>No description provided</Text>
        )}
      </View>
    </View>
  );
}
