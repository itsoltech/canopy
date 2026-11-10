import { useState } from "react";
import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { labelColors } from "@canopy/domain/github-pr";
import { Button } from "../../ui/components";
import { useTypography } from "../../ui/theme";

export function PullRequestLabels({ snapshot }: { snapshot: github.PullRequestSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const type = useTypography();

  const labels = snapshot.labelDetails.length
    ? snapshot.labelDetails
    : snapshot.labels.map((name) => ({ name, color: "" }));

  if (!labels.length) return null;

  return (
    <View accessibilityLabel="Labels" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
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
  );
}
