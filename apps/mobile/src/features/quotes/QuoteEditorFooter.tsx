import { View } from "react-native";
import { QUOTE_LIMITS } from "@canopy/domain";
import { Button, Field, IconButton } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";

/** The note and primary action stay above the keyboard while the passage gives up space. */
export function QuoteEditorFooter({
  comment,
  onChangeComment,
  editing,
  compact,
  inline,
  disabled,
  onSave,
  onRemove,
}: {
  comment: string;
  onChangeComment: (value: string) => void;
  editing: boolean;
  compact: boolean;
  inline: boolean;
  disabled: boolean;
  onSave: () => void;
  onRemove?: (() => void) | undefined;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <View
      style={{
        gap: compact ? 8 : 12,
        flexDirection: inline ? "row" : "column",
        alignItems: inline ? "flex-end" : undefined,
      }}
    >
      <View style={inline ? { flex: 1, minWidth: 0 } : undefined}>
        <Field
          label="Comment (optional)"
          value={comment}
          onChangeText={onChangeComment}
          multiline
          maxLength={QUOTE_LIMITS.maxCommentChars}
          style={{ height: compact ? Math.max(40, type.body.lineHeight + 16) : 80, textAlignVertical: "top" }}
        />
      </View>
      <View style={{ flex: inline ? 1 : undefined, flexDirection: "row", alignItems: "center", gap: 12 }}>
        {onRemove && <IconButton icon="trash" label="Remove citation" color={c.danger} onPress={onRemove} />}
        <View style={{ flex: 1 }}>
          <Button title={editing ? "Save quote" : "Add quote"} variant="primary" disabled={disabled} onPress={onSave} />
        </View>
      </View>
    </View>
  );
}
