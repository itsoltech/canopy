import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, ScrollView, Text, View } from "react-native";
import type { BlobRef } from "@canopy/contracts";
import { Button } from "../../ui/Button";
import { TextViewerFrame } from "./TextViewerFrame";
import { styles, useColors, useTypography } from "../../ui/theme";
import { CopyAction } from "./copy-action";
import { QuoteAction } from "../quotes/QuoteAction";
import { DiffContent } from "../../ui/DiffContent";
import { QUOTE_LIMITS } from "@canopy/domain";
import { Markdown } from "../../ui/markdown/Markdown";
import { Segmented } from "../../ui/Segmented";
import { useDevicePreferences } from "../settings/device-preferences";
import { useTextContent } from "./useTextContent";
import { Switch } from "../../ui/Switch";

export const INLINE_PREVIEW = 12_000;

/** Bound each native Text and the mounted window, including for a single enormous output line. */
function chunksOf(text: string) {
  const chunks: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    const maximum = Math.min(offset + 4096, text.length);
    const newline = text.lastIndexOf("\n", maximum - 1);
    let end = newline >= offset ? newline + 1 : maximum;
    const last = text.charCodeAt(end - 1);

    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(text.slice(offset, end));
    offset = end;
  }

  return chunks;
}

function TextChunk({ text, diff }: { text: string; diff: boolean }) {
  const c = useColors();
  const type = useTypography();

  return diff ? (
    <DiffContent diff={text} />
  ) : (
    <Text selectable style={[type.mono, { color: c.text }]}>
      {text}
    </Text>
  );
}

export function TextViewer({
  text = "",
  blob,
  threadId,
  label,
  diff = false,
  onClose,
  extraActions,
  attachment = false,
  markdown = false,
  notice,
  toolbar,
  embedded = false,
}: {
  text?: string;
  blob?: BlobRef | undefined;
  threadId: string;
  label: string;
  diff?: boolean;
  onClose: () => void;
  extraActions?: ReactNode;
  attachment?: boolean;
  markdown?: boolean;
  notice?: string;
  toolbar?: ReactNode;
  embedded?: boolean;
}) {
  const c = useColors();
  const { loaded, error, tooLarge, retry } = useTextContent(text, blob, threadId);
  const preferences = useDevicePreferences();
  const [wrap, setWrap] = useState(true);
  const rendered = markdown && preferences.values.attachmentMarkdown === "rendered";

  const chunks = useMemo(() => chunksOf(loaded ?? ""), [loaded]);

  return (
    <TextViewerFrame
      embedded={embedded}
      title={label}
      onClose={onClose}
      actions={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {loaded ? (
            <>
              <CopyAction text={loaded} label={attachment ? "Copy text" : diff ? "Copy diff" : "Copy output"} />
              {!attachment && <QuoteAction text={loaded} kind={diff ? "diff" : "command_output"} />}
            </>
          ) : null}
          {extraActions}
        </View>
      }
    >
      {attachment && (
        <View style={{ padding: 12, gap: 8 }}>
          {toolbar}
          {notice && <Text style={[styles.caption, { color: c.muted }]}>{notice}</Text>}
          {markdown && (
            <Segmented
              options={[
                { value: "rendered", label: "Rendered" },
                { value: "source", label: "Source" },
              ]}
              value={preferences.values.attachmentMarkdown}
              onChange={(value) => preferences.set("attachmentMarkdown", value)}
            />
          )}
          {!rendered && (
            <View style={[styles.row, { gap: 12, minHeight: 44 }]}>
              <Text style={[styles.caption, { color: c.text }]}>Wrap lines</Text>
              <Switch label="Wrap lines" value={wrap} onChange={setWrap} />
            </View>
          )}
        </View>
      )}
      {tooLarge || error ? (
        <View style={{ padding: 20, gap: 12 }}>
          <Text accessibilityRole="alert" style={[styles.body, { color: c.muted }]}>
            {tooLarge ? "This content exceeds the 8 MB viewing limit. Ask the agent for a smaller section." : error}
          </Text>
          {!tooLarge && <Button title="Retry" onPress={retry} />}
        </View>
      ) : loaded === undefined ? (
        <ActivityIndicator accessibilityLabel="Loading content" style={{ padding: 24 }} color={c.muted} />
      ) : rendered ? (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <Markdown text={loaded} />
        </ScrollView>
      ) : attachment && !wrap ? (
        <ScrollView horizontal contentContainerStyle={{ minWidth: "100%" }}>
          <FlatList
            data={chunks}
            keyExtractor={(_chunk, index) => String(index)}
            renderItem={({ item }) => <TextChunk text={item} diff={false} />}
            initialNumToRender={4}
            maxToRenderPerBatch={4}
            windowSize={5}
            contentContainerStyle={{ padding: 16 }}
          />
        </ScrollView>
      ) : (
        <FlatList
          data={chunks}
          keyExtractor={(_chunk, index) => String(index)}
          renderItem={({ item }) => (
            <View>
              <TextChunk text={item} diff={diff} />
              {!attachment && loaded.length > QUOTE_LIMITS.maxTextChars && (
                <QuoteAction text={item} kind={diff ? "diff" : "command_output"} />
              )}
            </View>
          )}
          initialNumToRender={4}
          maxToRenderPerBatch={4}
          windowSize={5}
          contentContainerStyle={{ padding: 16 }}
          ListEmptyComponent={<Text style={[styles.body, { color: c.muted }]}>No content.</Text>}
        />
      )}
    </TextViewerFrame>
  );
}
