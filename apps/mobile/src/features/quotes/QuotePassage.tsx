import { ScrollView, Text, View } from "react-native";
import * as Linking from "expo-linking";
import type { ui } from "@canopy/contracts";
import { citationPreview, isCodeQuote, QUOTE_LIMITS } from "@canopy/domain";
import { safeHref } from "@canopy/domain/markdown";
import { Button } from "../../ui/Button";
import { TextInput } from "../../ui/TextInput";
import { Markdown } from "../../ui/markdown/Markdown";
import { styles, useColors, useTypography } from "../../ui/theme";

/** Reading and trimming share one bounded area; neither can push the note below the keyboard. */
export function QuotePassage({
  quote,
  text,
  onChangeText,
  editing,
  onEdit,
  onSource,
}: {
  quote: ui.Quote;
  text: string;
  onChangeText: (value: string) => void;
  editing: boolean;
  onEdit: () => void;
  onSource: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const preview = citationPreview({ ...quote, text });
  const code = isCodeQuote(quote.sourceKind);
  const url = safeHref(preview.url);

  return (
    <View style={{ flex: 1, minHeight: 0, gap: 12, padding: 20, paddingTop: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Text style={[styles.label, { color: c.text, flexShrink: 1 }]}>Passage</Text>
        {!editing && <Button title="Edit passage" variant="ghost" size="sm" icon="pencil-square" onPress={onEdit} />}
      </View>
      {editing ? (
        <TextInput
          accessibilityLabel="Passage"
          value={text}
          onChangeText={onChangeText}
          multiline
          autoFocus
          maxLength={QUOTE_LIMITS.maxTextChars}
          style={[
            styles.input,
            code ? type.mono : type.body,
            {
              flex: 1,
              minHeight: 0,
              color: c.text,
              backgroundColor: c.surface,
              borderColor: c.accent,
              textAlignVertical: "top",
            },
          ]}
        />
      ) : (
        <ScrollView
          style={{
            flex: 1,
            minHeight: 0,
            borderRadius: 12,
            backgroundColor: c.surface,
            borderWidth: 1,
            borderColor: c.line,
          }}
          contentContainerStyle={{ padding: 16, gap: 16 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {quote.text.length > QUOTE_LIMITS.maxTextChars && text.length === QUOTE_LIMITS.maxTextChars && (
            <Text style={[type.small, { color: c.muted }]}>
              This quote includes only the first 20,000 characters. Edit the passage to shorten it.
            </Text>
          )}
          <Text selectable style={[type.small, { color: c.muted }]}>
            {preview.caption}
          </Text>
          {(quote.sourceItemId || url) && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {quote.sourceItemId ? (
                <Button title="Jump to source" variant="ghost" size="sm" onPress={onSource} />
              ) : null}
              {url ? (
                <Button title="Open on GitHub" variant="ghost" size="sm" onPress={() => void Linking.openURL(url)} />
              ) : null}
            </View>
          )}
          <View style={{ borderLeftWidth: 2, borderColor: c.line, paddingLeft: 12 }}>
            {preview.markdown ? (
              <Markdown text={preview.text} />
            ) : (
              <Text selectable style={[code ? type.mono : type.body, { color: c.text }]}>
                {preview.text}
              </Text>
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}
