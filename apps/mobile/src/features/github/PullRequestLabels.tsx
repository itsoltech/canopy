import { useState } from "react";
import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { labelColors } from "@canopy/domain/github-pr";
import { Button } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";
import { MetadataEdit } from "./MetadataEdit";

export function PullRequestLabels({ snapshot }: { snapshot: github.PullRequestSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const type = useTypography();
  const c = useColors();
  const [display, setDisplay] = useState<github.PullRequestMetadata>();

  const labels =
    display?.labels ??
    (snapshot.labelDetails.length ? snapshot.labelDetails : snapshot.labels.map((name) => ({ name, color: "" })));

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={[type.meta, { color: c.muted }]}>Labels</Text>
        <MetadataEdit snapshot={snapshot} kind="labels" onDisplay={setDisplay} />
      </View>
      {!labels.length && <Text style={[type.small, { color: c.muted }]}>No labels</Text>}
      <View
        accessibilityLabel="Labels"
        style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}
      >
        {(expanded ? labels : labels.slice(0, 4)).map((label, i) => {
          const color = labelColors(label.color);

          return (
            <Text
              key={`${label.name}:${i}`}
              numberOfLines={1}
              style={[
                type.meta,
                {
                  maxWidth: 180,
                  color: color.foreground,
                  backgroundColor: color.background,
                  borderRadius: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                },
              ]}
            >
              {label.name}
            </Text>
          );
        })}
        {labels.length > 4 && (
          <Button
            variant="ghost"
            size="sm"
            title={expanded ? "Show less" : `+${labels.length - 4}`}
            onPress={() => setExpanded(!expanded)}
          />
        )}
      </View>
    </View>
  );
}
