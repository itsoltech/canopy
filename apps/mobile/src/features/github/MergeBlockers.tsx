import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { mergeBlocker } from "@canopy/domain/github-lifecycle-display";
import { Button, Notice } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { useColors, useTypography } from "../../ui/theme";

export function MergeBlockers({ reasons }: { reasons: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState("");

  const c = useColors(),
    type = useTypography();

  if (!reasons.length) return null;

  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text style={[type.meta, { color: c.muted }]}>Merging blocked</Text>
        {(expanded ? reasons : reasons.slice(0, 2)).map(mergeBlocker).map((reason) => (
          <Pressable
            key={reason.detail}
            accessibilityRole="button"
            accessibilityLabel={reason.label}
            accessibilityHint={reason.detail}
            onPress={() => setDetail(detail === reason.detail ? "" : reason.detail)}
            hitSlop={8}
            style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 32 }}
          >
            <Icon name={reason.icon} size={14} color={c.muted} />
            <Text style={[type.meta, { color: c.muted }]}>{reason.label}</Text>
          </Pressable>
        ))}
        {reasons.length > 2 && (
          <Button
            title={expanded ? "Show less" : `+${reasons.length - 2} more`}
            size="sm"
            variant="ghost"
            onPress={() => setExpanded(!expanded)}
          />
        )}
      </View>
      {!!detail && reasons.includes(detail) && <Notice>{detail}</Notice>}
    </View>
  );
}
