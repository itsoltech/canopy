import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { QUOTE_LIMITS } from "@canopy/domain";
import { IconButton } from "../../ui/components";
import { TextInput } from "../../ui/TextInput";
import { styles, useColors } from "../../ui/theme";
import type { useQuoteDraft } from "./useQuoteDraft";

export function QuotePreview({ quote, mine = false }: { quote: ui.Quote; mine?: boolean }) {
  const c = useColors();
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={{ gap: 4, borderLeftWidth: 2, borderColor: mine ? c.botUserText : c.accent, paddingLeft: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={expanded ? "Collapse quote" : "Expand quote"}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <Text numberOfLines={expanded ? undefined : 3} style={[styles.meta, { color: mine ? c.botUserText : c.muted }]}>
          {quote.text}
        </Text>
      </Pressable>
      {quote.comment ? (
        <Text style={[styles.body, { color: mine ? c.botUserText : c.text }]}>{quote.comment}</Text>
      ) : null}
    </View>
  );
}

/** Reply quotes share the composer width and scroll before pushing the input off a phone. */
export function InlineQuoteDrafts({ draft, busy }: { draft: ReturnType<typeof useQuoteDraft>; busy: boolean }) {
  const c = useColors();
  const { quotes } = draft;

  if (!quotes.length) return null;

  return (
    <ScrollView
      style={{ maxHeight: 200 }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: 8, padding: 8 }}
    >
      {quotes.map((quote, index) => (
        <View key={index} style={{ padding: 10, borderRadius: 12, backgroundColor: c.surface, gap: 8 }}>
          <View style={[styles.row, { alignItems: "flex-start" }]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <QuotePreview quote={{ ...quote, comment: "" }} />
            </View>
            <IconButton icon="x-mark" label="Remove quote" disabled={busy} onPress={() => draft.remove(index)} />
          </View>
          <TextInput
            accessibilityLabel={`Comment on quote ${index + 1}`}
            placeholder="Comment"
            placeholderTextColor={c.faint}
            value={quote.comment}
            maxLength={QUOTE_LIMITS.maxCommentChars}
            editable={!busy}
            multiline
            onChangeText={(comment) => draft.edit(index, { ...quote, comment })}
            style={[styles.body, { color: c.text, minHeight: 44 }]}
          />
        </View>
      ))}
    </ScrollView>
  );
}
