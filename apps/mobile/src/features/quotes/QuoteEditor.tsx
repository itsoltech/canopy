import { useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import type { ui } from "@canopy/contracts";
import { QUOTE_LIMITS } from "@canopy/domain";
import { KeyboardController, useKeyboardState } from "react-native-keyboard-controller";
import { Button } from "../../ui/Button";
import { SheetSurface } from "../../ui/SheetSurface";
import { SheetCloseButton } from "../../ui/SheetDragArea";
import { styles, useColors } from "../../ui/theme";
import { QuoteSource } from "./QuoteSource";
import { QuotePassage } from "./QuotePassage";
import { QuoteEditorFooter } from "./QuoteEditorFooter";

/** Preview and edit a passage and its optional comment before saving the citation. */
export function QuoteEditor({
  quote,
  onSave,
  onClose,
  editing = false,
  onRemove,
}: {
  quote: ui.Quote;
  onSave: (quote: ui.Quote) => void;
  onClose: () => void;
  editing?: boolean;
  onRemove?: () => void;
}) {
  const [text, setText] = useState(quote.text.slice(0, QUOTE_LIMITS.maxTextChars));
  const [comment, setComment] = useState(quote.comment);
  const [editingPassage, setEditingPassage] = useState(false);
  const [source, setSource] = useState(false);
  const c = useColors();
  const { width, height } = useWindowDimensions();
  const keyboardHeight = useKeyboardState((state) => state.height);
  const compact = height < 700 || height - keyboardHeight < 500;
  const title = editing ? "Edit citation" : "Quote passage";

  function preview() {
    void KeyboardController.dismiss();
    setEditingPassage(false);
  }

  return (
    <SheetSurface
      label={title}
      visible
      onClose={onClose}
      scroll={false}
      header={
        <View style={{ minHeight: 44, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text accessibilityRole="header" numberOfLines={2} style={[styles.heading, { flex: 1, color: c.text }]}>
            {title}
          </Text>
          <SheetCloseButton label={`Close ${title}`} />
        </View>
      }
      footer={
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: compact ? 4 : 16,
            borderTopWidth: 1,
            borderColor: c.line,
            backgroundColor: c.surface,
          }}
        >
          {editingPassage ? (
            <Button title="Use passage" variant="primary" disabled={!text.trim()} onPress={preview} />
          ) : (
            <QuoteEditorFooter
              comment={comment}
              onChangeComment={setComment}
              editing={editing}
              compact={compact}
              inline={width > height}
              disabled={!text.trim()}
              onSave={() => {
                onSave({ ...quote, text, comment });
                onClose();
              }}
              onRemove={
                onRemove &&
                (() => {
                  onRemove();
                  onClose();
                })
              }
            />
          )}
        </View>
      }
    >
      <View style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <QuotePassage
          quote={quote}
          text={text}
          onChangeText={setText}
          editing={editingPassage}
          onEdit={() => setEditingPassage(true)}
          onSource={() => setSource(true)}
        />
      </View>
      {source && <QuoteSource quote={quote} onClose={() => setSource(false)} />}
    </SheetSurface>
  );
}
