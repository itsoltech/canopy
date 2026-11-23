import { memo, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Text, View, type ListRenderItemInfo } from "react-native";
import type { Token } from "marked";
import { lexMarkdown } from "@canopy/domain/markdown";
import { MarkdownBlock } from "../../ui/markdown/Blocks";
import { MarkdownScopeProvider } from "../../ui/markdown/scope";
import { styles, useColors } from "../../ui/theme";

export function isMarkdownFile(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name);
}

/** Parse on demand and retain just the last preview for this open file. */
export function useWorkspaceMarkdown(text: string | undefined, active: boolean): readonly Token[] | null | undefined {
  const [preview, setPreview] = useState<{ text: string; tokens: Token[] | null }>();
  const cached = preview?.text === text;

  useEffect(() => {
    if (!active || text === undefined || cached) return;

    const job = requestIdleCallback(
      () => {
        try {
          const tokens = lexMarkdown(text).filter((token) => token.type !== "space" && token.type !== "def");
          setPreview({ text, tokens });
        } catch {
          setPreview({ text, tokens: null });
        }
      },
      { timeout: 250 },
    );

    return () => cancelIdleCallback(job);
  }, [text, cached, active]);

  return cached ? preview?.tokens : undefined;
}

const renderBlock = ({ item }: ListRenderItemInfo<Token>) => <MarkdownBlock token={item} />;
const blockKey = (_item: Token, index: number) => String(index);
const restore = (code: string) => code;
const BlockGap = () => <View style={{ height: 12 }} />;

export const WorkspaceMarkdown = memo(function WorkspaceMarkdown({
  tokens,
}: {
  tokens: readonly Token[] | null | undefined;
}) {
  const c = useColors();

  if (tokens === undefined) {
    return <ActivityIndicator accessibilityLabel="Preparing Markdown…" color={c.muted} style={{ padding: 16 }} />;
  }

  if (tokens === null || tokens.length === 0) {
    return (
      <Text
        accessibilityRole={tokens === null ? "alert" : undefined}
        style={[styles.body, { color: c.muted, padding: 16 }]}
      >
        {tokens === null ? "Could not render Markdown. View the source to read the file." : "No content."}
      </Text>
    );
  }

  return (
    <MarkdownScopeProvider value={{ ink: c.body, strong: c.text, selectable: true, restore, render: undefined }}>
      <FlatList
        data={tokens}
        renderItem={renderBlock}
        keyExtractor={blockKey}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={5}
        ItemSeparatorComponent={BlockGap}
        contentContainerStyle={{ padding: 16 }}
      />
    </MarkdownScopeProvider>
  );
});
