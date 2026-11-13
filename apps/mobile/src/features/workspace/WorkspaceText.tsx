import { useEffect, useMemo, useRef } from "react";
import { FlatList, ScrollView, Text, View } from "react-native";
import type { WorkspaceFile } from "@canopy/domain/workspace-file";
import { useColors, useTypography } from "../../ui/theme";

/** A bounded native window of source lines; selection and positions refer to original line numbers. */
export function WorkspaceText({ document }: { document: WorkspaceFile }) {
  const c = useColors();
  const type = useTypography();
  const list = useRef<FlatList<SourceRow>>(null);
  const rows = useMemo(() => sourceRows(document.text), [document.text]);
  const height = Math.max(24, type.mono.lineHeight ?? 24);
  const position = document.position;
  const revision = document.positionRevision;

  useEffect(() => {
    if (!position || document.readerPositionRevision === revision) return;
    const index = rows.findIndex((row) => row.line === position.line);

    if (index < 0) return;
    list.current?.scrollToIndex({ index, animated: false });
    document.readerPositionRevision = revision;
  }, [document, position, revision, rows]);

  return (
    <FlatList
      ref={list}
      data={rows}
      keyExtractor={(_, index) => String(index)}
      initialNumToRender={40}
      maxToRenderPerBatch={40}
      windowSize={5}
      initialScrollIndex={Math.min(rows.length - 1, Math.max(0, Math.floor(document.scroll / height)))}
      getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
      onScroll={(event) => {
        document.scroll = event.nativeEvent.contentOffset.y;
      }}
      scrollEventThrottle={100}
      renderItem={({ item }) => (
        <View
          style={{
            height,
            flexDirection: "row",
            backgroundColor: position && item.line >= position.line && item.line <= position.end ? c.recess : undefined,
          }}
        >
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={[type.mono, { color: c.muted, width: 64, paddingRight: 12, textAlign: "right" }]}
          >
            {item.continued ? "↳" : item.line}
          </Text>
          <ScrollView horizontal style={{ flex: 1 }}>
            <Text
              selectable
              accessibilityLabel={item.continued ? `Line ${item.line}, continued. ${item.text}` : undefined}
              style={[type.mono, { color: c.text }]}
            >
              {item.text}
            </Text>
          </ScrollView>
        </View>
      )}
    />
  );
}

interface SourceRow {
  text: string;
  line: number;
  continued: boolean;
}

/** Bound each native Text without dropping characters or guessing the width of Unicode glyphs. */
function sourceRows(text: string): SourceRow[] {
  return text.split("\n").flatMap((line, index) => {
    const rows: SourceRow[] = [];
    let offset = 0;

    do {
      let end = Math.min(offset + 4096, line.length);
      const last = line.charCodeAt(end - 1);

      if (end < line.length && last >= 0xd800 && last <= 0xdbff) end--;
      rows.push({ text: line.slice(offset, end), line: index + 1, continued: offset > 0 });
      offset = end;
    } while (offset < line.length);

    return rows;
  });
}
