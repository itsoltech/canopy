import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useDevicePreferences } from "../features/settings/device-preferences";
import { Segmented } from "./components";
import { styles, useColors, useTypography } from "./theme";
import { diffRows } from "./diff-lines";

/** `bare`: always open, without its own header (the row above it names the file and opens or folds it). */
export function Diff({ diff, label = "File changes", bare = false }: { diff: string; label?: string; bare?: boolean }) {
  const c = useColors();
  const type = useTypography();
  const { values, set } = useDevicePreferences();
  const [open, setOpen] = useState(values.diffFileState !== "collapsed");
  const rows = useMemo(() => diffRows(diff, values.hideWhitespace === "on"), [diff, values.hideWhitespace]);
  const addition = values.diffColors === "blue-orange" ? c.sky : c.success;
  const deletion = values.diffColors === "blue-orange" ? c.warning : c.danger;
  const wrapped = values.wrapDiffs === "on";
  const split = values.diffLayout === "split";

  const lineView = (line: string | undefined, color: string, changed = false) => (
    <Text
      selectable
      style={{ ...type.mono, color, paddingHorizontal: 8, backgroundColor: changed ? `${color}14` : "transparent" }}
    >
      {line || " "}
    </Text>
  );

  const content = (
    <View style={{ minWidth: wrapped ? undefined : 320 }}>
      {rows.map((row, i) =>
        "context" in row ? (
          <View key={i}>{lineView(row.context, c.muted)}</View>
        ) : split ? (
          <View key={i} style={{ flexDirection: "row" }}>
            <View style={{ width: "50%", borderRightWidth: 1, borderColor: c.line }}>
              {lineView(row.before, deletion, !!row.before)}
            </View>
            <View style={{ width: "50%" }}>{lineView(row.after, addition, !!row.after)}</View>
          </View>
        ) : (
          <View key={i}>
            {row.before !== undefined && lineView(row.before, deletion, true)}
            {row.after !== undefined && lineView(row.after, addition, true)}
          </View>
        ),
      )}
    </View>
  );

  return (
    <View accessibilityLabel={label} style={{ gap: 8 }}>
      {!bare && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text style={[styles.chrome, { color: c.text }]}>
            {open ? "▾" : "▸"} {label}
          </Text>
        </Pressable>
      )}
      {(open || bare) && (
        <>
          <Segmented
            value={values.diffLayout}
            options={[
              { value: "stacked", label: "Stacked" },
              { value: "split", label: "Side by side" },
            ]}
            onChange={(value) => set("diffLayout", value)}
          />
          <View style={{ borderRadius: 8, overflow: "hidden", paddingVertical: 8, backgroundColor: c.inset }}>
            {wrapped ? (
              content
            ) : (
              // Not growing: in a fit-content parent (a chat bubble) a growing sideways scroller takes a runaway height on iOS.
              <ScrollView horizontal style={{ flexGrow: 0 }}>
                {content}
              </ScrollView>
            )}
          </View>
        </>
      )}
    </View>
  );
}
