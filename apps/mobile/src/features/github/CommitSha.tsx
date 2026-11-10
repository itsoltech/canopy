import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useColors, useTypography } from "../../ui/theme";

/** Tap exposes a selectable full commit ID without expanding the normal confirmation row. */
export function CommitSha({ sha }: { sha: string }) {
  const [expanded, setExpanded] = useState(false);

  const c = useColors(),
    type = useTypography();

  return (
    <View style={{ alignItems: "flex-start", gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Head commit ${sha}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        hitSlop={8}
      >
        <Text style={[type.mono, { color: c.text }]}>{sha.slice(0, 7)}</Text>
      </Pressable>
      {expanded && (
        <Text selectable style={[type.mono, { color: c.muted }]}>
          {sha}
        </Text>
      )}
    </View>
  );
}
