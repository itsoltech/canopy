import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { useDevicePreferences } from "../features/settings/device-preferences";
import { useColors, useTypography } from "./theme";
import { diffRows, type DiffRow } from "./diff-lines";
import { DiffGutter, type DiffReview } from "./DiffGutter";
import type { DiffSide } from "@canopy/domain/diff-anchors";

/** Shared by the bounded timeline preview and virtualized full-diff chunks. */
export function DiffContent({
  diff,
  selectable = true,
  review,
  sourceRows,
}: {
  diff: string;
  selectable?: boolean;
  review?: DiffReview | undefined;
  sourceRows?: DiffRow[];
}) {
  const c = useColors();
  const type = useTypography();
  const { values } = useDevicePreferences();
  const parsed = useMemo(() => diffRows(diff, values.hideWhitespace === "on"), [diff, values.hideWhitespace]);
  const rows = sourceRows ?? parsed;
  const addition = values.diffColors === "blue-orange" ? c.sky : c.success;
  const deletion = values.diffColors === "blue-orange" ? c.warning : c.danger;
  const wrapped = values.wrapDiffs === "on";
  const split = values.diffLayout === "split";

  const lineView = (line: string | undefined, color: string, changed = false) => (
    <Text
      selectable={selectable}
      style={[type.mono, { color, paddingHorizontal: 8, backgroundColor: changed ? `${color}14` : "transparent" }]}
    >
      {line || " "}
    </Text>
  );

  const numbered = (row: DiffRow, line: string | undefined, color: string, changed = false, side?: DiffSide) => (
    <View style={{ flexDirection: "row", minWidth: 0, alignItems: "stretch" }}>
      {review && <DiffGutter left={row.left?.left ?? 0} right={row.right?.right ?? 0} side={side} review={review} />}
      <View style={{ flex: wrapped ? 1 : undefined, minWidth: 0, justifyContent: "center" }}>
        {lineView(line, color, changed)}
      </View>
    </View>
  );

  const content = (
    <View style={{ minWidth: wrapped ? undefined : 320 }}>
      {rows.map((row, index) =>
        "context" in row ? (
          <View key={index}>{numbered(row, row.context, c.muted)}</View>
        ) : split ? (
          <View key={index} style={{ flexDirection: "row" }}>
            <View style={{ width: "50%", borderRightWidth: 1, borderColor: c.line }}>
              {numbered(row, row.before, deletion, !!row.before, "LEFT")}
            </View>
            <View style={{ width: "50%" }}>{numbered(row, row.after, addition, !!row.after, "RIGHT")}</View>
          </View>
        ) : (
          <View key={index}>
            {row.before !== undefined && numbered(row, row.before, deletion, true, "LEFT")}
            {row.after !== undefined && numbered(row, row.after, addition, true, "RIGHT")}
          </View>
        ),
      )}
    </View>
  );

  return wrapped ? (
    content
  ) : (
    <ScrollView horizontal style={{ flexGrow: 0 }}>
      {content}
    </ScrollView>
  );
}
