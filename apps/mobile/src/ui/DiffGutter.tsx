import { Pressable, Text, View } from "react-native";
import { selectedLine, type DiffPoint, type DiffRange, type DiffSide } from "@canopy/domain/diff-anchors";
import { useColors, useTypography } from "./theme";

export interface DiffReview {
  selection?: DiffRange | undefined;
  onSelect: (point: DiffPoint) => void;
}

export function DiffGutter({
  left,
  right,
  side,
  review,
}: {
  left: number;
  right: number;
  side?: DiffSide;
  review: DiffReview;
}) {
  const c = useColors(),
    type = useTypography();

  const sides: DiffSide[] = side ? [side] : ["LEFT", "RIGHT"];

  return (
    <View style={{ flexDirection: "row" }}>
      {sides.map((s) => {
        const line = s === "LEFT" ? left : right;
        const selected = selectedLine(review.selection, s, line);

        return line ? (
          <Pressable
            key={s}
            accessibilityRole="button"
            accessibilityLabel={`Add comment on ${s} line ${line}`}
            accessibilityState={{ selected }}
            onPress={() => review.onSelect({ side: s, line })}
            style={{
              width: 48,
              minHeight: 48,
              justifyContent: "center",
              alignItems: "flex-end",
              paddingRight: 6,
              borderRightWidth: 1,
              borderColor: c.line,
              backgroundColor: selected ? `${c.sky}22` : c.inset,
            }}
          >
            <Text style={[type.mono, { color: selected ? c.sky : c.muted }]}>{line}</Text>
          </Pressable>
        ) : (
          <View key={s} style={{ width: 48 }} />
        );
      })}
    </View>
  );
}
