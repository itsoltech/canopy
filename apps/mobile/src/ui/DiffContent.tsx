import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { useDevicePreferences } from "../features/settings/device-preferences";
import { useColors, useTypography } from "./theme";
import { diffRows } from "./diff-lines";

/** Shared by the bounded timeline preview and virtualized full-diff chunks. */
export function DiffContent({ diff }: { diff: string }) {
  const c = useColors();
  const type = useTypography();
  const { values } = useDevicePreferences();
  const rows = useMemo(() => diffRows(diff, values.hideWhitespace === "on"), [diff, values.hideWhitespace]);
  const addition = values.diffColors === "blue-orange" ? c.sky : c.success;
  const deletion = values.diffColors === "blue-orange" ? c.warning : c.danger;
  const wrapped = values.wrapDiffs === "on";
  const split = values.diffLayout === "split";

  const lineView = (line: string | undefined, color: string, changed = false) => (
    <Text
      selectable
      style={[type.mono, { color, paddingHorizontal: 8, backgroundColor: changed ? `${color}14` : "transparent" }]}
    >
      {line || " "}
    </Text>
  );

  const content = (
    <View style={{ minWidth: wrapped ? undefined : 320 }}>
      {rows.map((row, index) =>
        "context" in row ? (
          <View key={index}>{lineView(row.context, c.muted)}</View>
        ) : split ? (
          <View key={index} style={{ flexDirection: "row" }}>
            <View style={{ width: "50%", borderRightWidth: 1, borderColor: c.line }}>
              {lineView(row.before, deletion, !!row.before)}
            </View>
            <View style={{ width: "50%" }}>{lineView(row.after, addition, !!row.after)}</View>
          </View>
        ) : (
          <View key={index}>
            {row.before !== undefined && lineView(row.before, deletion, true)}
            {row.after !== undefined && lineView(row.after, addition, true)}
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
