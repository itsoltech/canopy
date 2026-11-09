import { useState } from "react";
import { View } from "react-native";
import type { ui } from "@canopy/contracts";
import { QUOTE_LIMITS } from "@canopy/domain";
import { Button, Field, Sheet } from "../../ui/components";
import { Notice } from "../../ui/Alert";

/** Native selection menus cannot add actions in JS. This editable passage lets the reader keep any excerpt. */
export function QuoteEditor({
  quote,
  onSave,
  onClose,
  editing = false,
}: {
  quote: ui.Quote;
  onSave: (quote: ui.Quote) => void;
  onClose: () => void;
  editing?: boolean;
}) {
  const [text, setText] = useState(quote.text.slice(0, QUOTE_LIMITS.maxTextChars));
  const [comment, setComment] = useState(quote.comment);

  return (
    <Sheet title="Quote passage" visible onClose={onClose}>
      <Notice>Keep the passage you want to quote, then add a comment.</Notice>
      {quote.text.length > QUOTE_LIMITS.maxTextChars && (
        <Notice>Quotes can contain up to 20,000 characters. Keep a shorter passage.</Notice>
      )}
      <Field
        label="Passage"
        value={text}
        onChangeText={setText}
        multiline
        maxLength={QUOTE_LIMITS.maxTextChars}
        style={{ minHeight: 120, maxHeight: 280 }}
      />
      <Field
        label="Comment (optional)"
        value={comment}
        onChangeText={setComment}
        multiline
        maxLength={QUOTE_LIMITS.maxCommentChars}
      />
      <View style={{ alignItems: "flex-end" }}>
        <Button
          title={editing ? "Save quote" : "Add quote"}
          disabled={!text.trim()}
          onPress={() => {
            onSave({ ...quote, text, comment });
            onClose();
          }}
        />
      </View>
    </Sheet>
  );
}
