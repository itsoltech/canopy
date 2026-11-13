import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View, VirtualizedList, type VirtualizedListInstance } from "react-native";
import type { WorkspaceFile } from "@canopy/domain/workspace-file";
import type { SourceIndex, SourceRow } from "@canopy/syntax/source";
import { Button } from "../../ui/Button";
import { useColors, useTypography } from "../../ui/theme";
import { useSourceIndex } from "./useSourceIndex";
import { useFileHighlight } from "./useFileHighlight";
import { syntaxColors } from "./syntax-colors";

/** Virtual chunks keep original line numbers; a 2 MiB single line remains selectable in full. */
export function WorkspaceText({ document, draft }: { document: WorkspaceFile; draft?: string }) {
  const c = useColors();
  const type = useTypography();
  const source = draft ?? document.text;
  const index = useSourceIndex(source);
  const indexing = index.text !== source;
  const list = useRef<VirtualizedListInstance>(null);
  const savedOffset = useRef(draft === undefined ? document.scroll : 0);
  const restored = useRef(false);
  const viewport = useRef(0);
  const contentHeight = useRef(0);
  const height = Math.max(24, type.mono.lineHeight ?? 24);
  const [top, setTop] = useState(Math.floor(document.scroll / height));
  const [enabled, setEnabled] = useState(false);

  const large = useMemo(
    () => new TextEncoder().encode(source).length > 200 * 1024 || index.lines > 10_000 || index.longest > 2000,
    [source, index],
  );

  const first = index.row(Math.min(top, index.rows - 1)).line;
  const start = Math.floor((first - 1) / 80) * 80 + 1;
  const { tokens, note } = useFileHighlight(document, start, !indexing && (!large || enabled), draft);
  const colors = syntaxColors(c);
  const position = document.position;
  const revision = document.positionRevision;

  useEffect(() => {
    setEnabled(false);
  }, [source]);

  const restorePosition = useCallback(() => {
    if (indexing || !viewport.current || !list.current || contentHeight.current + 1 < index.rows * height) return;

    if (position && document.readerPositionRevision !== revision && position.line <= index.lines) {
      const row = index.rowForLine(position.line);
      list.current.scrollToIndex({ index: row, animated: false });
      setTop(row);
      document.readerPositionRevision = revision;
    } else if (!restored.current) {
      const offset = Math.min(savedOffset.current, Math.max(0, index.rows * height - viewport.current));
      list.current.scrollToOffset({ offset, animated: false });
      setTop(Math.floor(offset / height));
    }

    restored.current = true;
  }, [document, height, index, indexing, position, revision]);

  useEffect(restorePosition, [restorePosition]);

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      {(indexing || large || note) && (
        <View style={{ paddingHorizontal: 12, gap: 4 }}>
          <Text accessibilityLiveRegion="polite" style={[type.small, { color: c.muted }]}>
            {indexing
              ? "Preparing the rest of the file…"
              : note || "Large files are shown as plain text to keep them responsive."}
          </Text>
          {large && !enabled && <Button title="Enable highlighting" size="sm" onPress={() => setEnabled(true)} />}
        </View>
      )}
      <VirtualizedList
        ref={list}
        data={index}
        getItem={(data: SourceIndex, item: number) => data.row(item)}
        getItemCount={(data: SourceIndex) => data.rows}
        keyExtractor={(_, item) => String(item)}
        initialNumToRender={32}
        maxToRenderPerBatch={16}
        windowSize={2}
        getItemLayout={(_, item) => ({ length: height, offset: height * item, index: item })}
        onLayout={(event) => {
          viewport.current = event.nativeEvent.layout.height;
          restorePosition();
        }}
        onContentSizeChange={(_width, content) => {
          contentHeight.current = content;
          restorePosition();
        }}
        onScroll={(event) => {
          const offset = event.nativeEvent.contentOffset.y;
          setTop(Math.floor(offset / height));

          if (restored.current && !indexing && draft === undefined) document.scroll = offset;
        }}
        scrollEventThrottle={100}
        renderItem={({ item }: { item: SourceRow }) => {
          const spans = item.continued ? [] : (tokens.get(item.line)?.spans ?? []);

          return (
            <View
              style={{
                height,
                flexDirection: "row",
                backgroundColor:
                  position && item.line >= position.line && item.line <= position.end ? c.recess : undefined,
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
                <Text selectable style={[type.mono, { color: c.text }]}>
                  {spans.map((span, part) => (
                    <Text key={span.from}>
                      {source.slice(item.from + (spans[part - 1]?.to ?? 0), item.from + span.from)}
                      <Text style={{ color: colors[span.role] }}>
                        {source.slice(item.from + span.from, item.from + span.to)}
                      </Text>
                    </Text>
                  ))}
                  {source.slice(item.from + (spans.at(-1)?.to ?? 0), item.to)}
                </Text>
              </ScrollView>
            </View>
          );
        }}
      />
    </View>
  );
}
