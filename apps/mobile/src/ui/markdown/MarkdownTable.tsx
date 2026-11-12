import { useMemo, useState } from "react";
import { View, type TextStyle } from "react-native";
import type { Tokens } from "marked";
import { useColors, useTypography } from "../theme";
import { Inline } from "./Inline";
import { useMarkdownScope } from "./scope";
import { Faced } from "./text-style";
import { HorizontalScroll } from "../HorizontalScroll";

/** Bound headers as well as body cells, so a long heading cannot monopolize the table. */
const MAX_CELL = 224;
const MIN_CELL = 72;
const PAD = 8;

/** Average glyph width per point of font size, a little over Inter's so an estimate rarely wraps a header. */
const GLYPH = 0.6;

/**
 * Column widths from the length of their text: React Native has no table layout, so the widest cell of a
 * column or its header sets it, within the same bounds. A narrow table widens its columns toward the
 * message (`frame`), without exceeding the maximum. Tall tables retain their natural height in the feed.
 */
function columnWidths(table: Tokens.Table, fontSize: number, frame: number): number[] {
  const width = (text: string) => text.length * fontSize * GLYPH;

  const widths = table.header.map((header, column) => {
    let widest = width(header.text);

    for (const row of table.rows) widest = Math.max(widest, width(row[column]?.text ?? ""));

    return Math.min(MAX_CELL, Math.max(MIN_CELL, widest)) + PAD * 2;
  });

  const total = widths.reduce((sum, w) => sum + w, 0);

  return total < frame ? widths.map((w) => Math.min(MAX_CELL + PAD * 2, (w * frame) / total)) : widths;
}

const alignOf = (align: Tokens.Table["align"][number] | undefined): TextStyle["textAlign"] =>
  align === "center" ? "center" : align === "right" ? "right" : "left";

/**
 * A GFM table (web: MarkdownBlocks table): a bold header over a rule, rows between hairlines, cells aligned as
 * the source says. A table wider than the message scrolls sideways inside it.
 */
export function MarkdownTable({ table }: { table: Tokens.Table }) {
  const c = useColors();
  const type = useTypography();
  const { ink, strong, selectable } = useMarkdownScope();
  const [frame, setFrame] = useState(0);
  // web: text-sm/6, a step under the message with its line height.
  const fontSize = (type.body.fontSize * 14) / 16;
  const text: TextStyle = { ...type.body, fontSize, color: ink };
  const widths = useMemo(() => columnWidths(table, fontSize, frame), [table, fontSize, frame]);

  const row = (cells: Tokens.TableCell[], header: boolean) =>
    cells.map((cell, column) => {
      const width = widths[column] ?? MIN_CELL;

      return (
        <View
          key={column}
          style={{
            width,
            paddingVertical: 6,
            paddingLeft: column === 0 ? 0 : PAD,
            paddingRight: PAD,
          }}
        >
          <Faced
            selectable={selectable}
            weight={header ? "semibold" : "regular"}
            style={[text, { textAlign: alignOf(table.align[column]) }, header && { color: strong }]}
          >
            <Inline tokens={cell.tokens} />
          </Faced>
        </View>
      );
    });

  return (
    <HorizontalScroll onLayout={(event) => setFrame(event.nativeEvent.layout.width)}>
      <View>
        <View style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: c.line }}>
          {row(table.header, true)}
        </View>
        {table.rows.map((cells, index) => (
          <View key={index} style={{ flexDirection: "row", borderTopWidth: index === 0 ? 0 : 1, borderColor: c.rule }}>
            {row(cells, false)}
          </View>
        ))}
      </View>
    </HorizontalScroll>
  );
}
