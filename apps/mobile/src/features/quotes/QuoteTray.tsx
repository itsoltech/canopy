import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { IconButton } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import { QuoteEditor } from "./QuoteEditor";
import type { useQuoteDraft } from "./useQuoteDraft";
import { InlineQuoteDrafts } from "./QuotePreview";

export function QuoteTray({
  draft,
  inline = false,
  busy = false,
}: {
  draft: ReturnType<typeof useQuoteDraft>;
  inline?: boolean;
  busy?: boolean;
}) {
  const c = useColors();
  const [editing, setEditing] = useState<number>();
  const quote = editing === undefined ? undefined : draft.quotes[editing];

  if (!draft.quotes.length) return null;

  if (inline) return <InlineQuoteDrafts draft={draft} busy={busy} />;

  return (
    <>
      <ScrollView
        horizontal
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        keyboardShouldPersistTaps="handled"
      >
        {draft.quotes.map((item, index) => (
          <View key={index} style={[styles.row, { borderRadius: 8, backgroundColor: c.inset, width: 240 }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit quote"
              disabled={busy}
              onPress={() => setEditing(index)}
              style={{ flex: 1, minWidth: 0, padding: 8 }}
            >
              <Text numberOfLines={2} style={[styles.meta, { color: c.text }]}>
                {item.text}
              </Text>
              {item.comment ? (
                <Text numberOfLines={1} style={[styles.meta, { color: c.muted }]}>
                  {item.comment}
                </Text>
              ) : null}
            </Pressable>
            <IconButton
              icon="x-mark"
              label="Remove quote"
              size="sm"
              disabled={busy}
              onPress={() => draft.remove(index)}
            />
          </View>
        ))}
      </ScrollView>
      {quote && editing !== undefined && (
        <QuoteEditor
          editing
          quote={quote}
          onSave={(next) => draft.edit(editing, next)}
          onClose={() => setEditing(undefined)}
        />
      )}
    </>
  );
}
