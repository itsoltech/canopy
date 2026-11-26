import { useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { selectedLine, type DiffPoint, type DiffRange, type DiffSide } from "@canopy/domain/diff-anchors";
import { HorizontalScroll } from "../../ui/HorizontalScroll";
import type { DiffRow } from "../../ui/diff-lines";
import { useColors, useTypography } from "../../ui/theme";
import { useDevicePreferences } from "../settings/device-preferences";

const sides = ["LEFT", "RIGHT"] as const;

export function wrapReviewDiff({ wrapDiffs, diffLayout }: { wrapDiffs: string; diffLayout: string }) {
  return wrapDiffs === "on" || (wrapDiffs === "auto" && diffLayout === "stacked");
}

function lineNumber(row: DiffRow, side: DiffSide) {
  return side === "LEFT" ? (row.left?.left ?? 0) : (row.right?.right ?? 0);
}

function isHeader(row: DiffRow) {
  return "context" in row && !row.left?.left && !row.right?.right;
}

interface LineOptions {
  wrapped: boolean;
  gutterWidth: number;
  selection: DiffRange | undefined;
  onSelect: ((point: DiffPoint) => void) | undefined;
  colors: {
    text: string;
    muted: string;
    selected: string;
    addition: string;
    deletion: string;
  };
  mono: ReturnType<typeof useTypography>["mono"];
}

function LineNumber({ side, line, options }: { side: DiffSide; line: number; options: LineOptions }) {
  const { colors, mono, selection, onSelect, gutterWidth } = options;
  const selected = selectedLine(selection, side, line);
  const style = [styles.gutter, { width: gutterWidth, backgroundColor: selected ? `${colors.selected}26` : undefined }];

  if (!line) return <View style={style} />;

  const number = (
    <Text style={[mono, { color: selected ? colors.selected : colors.muted, textAlign: "right" }]}>{line}</Text>
  );

  if (!onSelect) return <View style={style}>{number}</View>;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Comment on ${side === "LEFT" ? "old" : "new"} line ${line}`}
      accessibilityState={{ selected }}
      onPress={() => onSelect({ side, line })}
      style={({ pressed }) => [style, pressed && { backgroundColor: `${colors.selected}26` }]}
    >
      {number}
    </Pressable>
  );
}

function ReviewLine({
  row,
  side,
  split,
  options,
}: {
  row: DiffRow;
  side?: DiffSide;
  split: boolean;
  options: LineOptions;
}) {
  const { colors, mono, wrapped } = options;
  const context = "context" in row;
  const line = context ? row.context : side === "LEFT" ? row.before : row.after;
  const changed = !context && line !== undefined;
  const color = changed ? (side === "LEFT" ? colors.deletion : colors.addition) : colors.text;

  return (
    <View
      style={[
        styles.line,
        options.onSelect && styles.selectableLine,
        split && wrapped && styles.column,
        changed && { backgroundColor: `${color}1a` },
      ]}
    >
      {(split && side ? [side] : sides).map((gutter) => (
        <LineNumber
          key={gutter}
          side={gutter}
          line={side && side !== gutter ? 0 : lineNumber(row, gutter)}
          options={options}
        />
      ))}
      <Text style={[mono, styles.marker, { color }]}>{changed ? line?.[0] : " "}</Text>
      <Text selectable style={[mono, styles.code, { color }, wrapped && styles.column]}>
        {line?.slice(1) || " "}
      </Text>
    </View>
  );
}

export function ReviewDiffLines({
  rows,
  lineDigits,
  selection,
  onSelect,
}: {
  rows: DiffRow[];
  lineDigits: number;
  selection: DiffRange | undefined;
  onSelect: ((point: DiffPoint) => void) | undefined;
}) {
  const c = useColors();
  const { mono } = useTypography();
  const { fontScale } = useWindowDimensions();
  const { values } = useDevicePreferences();
  const [frameWidth, setFrameWidth] = useState(0);
  const split = values.diffLayout === "split";
  const wrapped = wrapReviewDiff(values);
  const glyphWidth = mono.fontSize * fontScale * 0.72;
  const gutterWidth = Math.max(onSelect ? 48 : 28, Math.ceil(lineDigits * glyphWidth) + 8);
  const minWrappedWidth = gutterWidth * 2 + (split ? 2 : 1) * Math.ceil(glyphWidth * 8 + 18);
  const scrollWrapped = wrapped && frameWidth > 0 && minWrappedWidth > frameWidth;

  const options: LineOptions = {
    wrapped,
    gutterWidth,
    selection,
    onSelect,
    colors: {
      text: c.text,
      muted: c.muted,
      selected: c.sky,
      addition: values.diffColors === "blue-orange" ? c.sky : c.success,
      deletion: values.diffColors === "blue-orange" ? c.warning : c.danger,
    },
    mono,
  };

  function header(row: DiffRow, key: number, hidden = false) {
    return (
      <Text
        key={key}
        accessibilityElementsHidden={hidden}
        importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
        style={[mono, styles.header, { color: c.muted, backgroundColor: c.inset }]}
      >
        {!hidden && "context" in row ? row.context : " "}
      </Text>
    );
  }

  // Unwrapped columns can size to their own text because each pair occupies the same height.
  const content =
    split && !wrapped ? (
      <View style={styles.split}>
        {sides.map((side) => (
          <View
            key={side}
            style={[
              { minWidth: frameWidth / 2 },
              side === "LEFT" && { borderRightWidth: StyleSheet.hairlineWidth, borderColor: c.line },
            ]}
          >
            {rows.map((row, index) =>
              isHeader(row) ? (
                header(row, index, side === "RIGHT")
              ) : (
                <ReviewLine key={index} row={row} side={side} split options={options} />
              ),
            )}
          </View>
        ))}
      </View>
    ) : (
      <View style={{ minWidth: wrapped ? undefined : frameWidth, width: scrollWrapped ? minWrappedWidth : undefined }}>
        {rows.map((row, index) => {
          if (isHeader(row)) return header(row, index);

          if (split) {
            return (
              <View key={index} style={styles.split}>
                <ReviewLine row={row} side="LEFT" split options={options} />
                <View style={[styles.inlineDivider, { backgroundColor: c.line }]} />
                <ReviewLine row={row} side="RIGHT" split options={options} />
              </View>
            );
          }

          if ("context" in row) return <ReviewLine key={index} row={row} split={false} options={options} />;

          return (
            <View key={index}>
              {row.before !== undefined && <ReviewLine row={row} side="LEFT" split={false} options={options} />}
              {row.after !== undefined && <ReviewLine row={row} side="RIGHT" split={false} options={options} />}
            </View>
          );
        })}
      </View>
    );

  return (
    <View onLayout={(event) => setFrameWidth(event.nativeEvent.layout.width)}>
      {!wrapped || scrollWrapped ? <HorizontalScroll>{content}</HorizontalScroll> : content}
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", minHeight: 24 },
  selectableLine: { minHeight: 48 },
  code: { paddingRight: 8, paddingVertical: 2 },
  marker: { paddingLeft: 4, paddingRight: 6, paddingVertical: 2 },
  gutter: { justifyContent: "flex-start", paddingRight: 4, paddingVertical: 2 },
  header: { paddingHorizontal: 8, paddingVertical: 4 },
  split: { flexDirection: "row" },
  column: { flex: 1, minWidth: 0 },
  inlineDivider: { width: StyleSheet.hairlineWidth },
});
