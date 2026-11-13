import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { PullRequestChecks } from "./PullRequestChecks";
import { PullRequestLabels } from "./PullRequestLabels";
import { PullRequestPeople } from "./PullRequestPeople";
import { GitHubMarkdown as Markdown } from "./GitHubMarkdown";
import { useColors, useTypography } from "../../ui/theme";
import { useState } from "react";
import { MetadataEdit } from "./MetadataEdit";

export function PullRequestSummary({ snapshot }: { snapshot: github.PullRequestSnapshot }) {
  const c = useColors();
  const [metadata, setMetadata] = useState<github.PullRequestMetadata>();
  const body = metadata?.body ?? snapshot.body;
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
        <MetadataEdit snapshot={snapshot} kind="description" onDisplay={setMetadata} />
        {body ? (
          <Markdown
            text={body}
            pullRequestId={snapshot.summary?.ref?.id ?? ""}
            contentId={snapshot.summary?.ref?.nodeId ?? ""}
          />
        ) : (
          <Text style={[type.small, { color: c.muted }]}>No description provided</Text>
        )}
      </View>
    </View>
  );
}
