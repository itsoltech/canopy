import { Pressable, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { formatRelative } from "@canopy/domain/format";
import { Button, IconButton } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";

export function DraftRow({
  row,
  selected,
  disabled,
  onSelect,
  onTake,
  onDiscard,
}: {
  row: ui.ComposerDraft;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onTake: (replace: boolean) => void;
  onDiscard: () => void;
}) {
  const c = useColors();
  const preview = row.content?.text.trim() || (row.content?.quotes.length ? "Quoted text" : "Attachments");

  return (
    <View>
      <View style={[styles.row, { gap: 2 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Take over draft: ${preview}`}
          accessibilityState={{ disabled, expanded: selected }}
          disabled={disabled}
          onPress={onSelect}
          style={({ pressed }) => [
            styles.row,
            {
              minHeight: 40,
              flex: 1,
              minWidth: 0,
              paddingHorizontal: 8,
              gap: 6,
              backgroundColor: pressed ? c.control : undefined,
              borderRadius: 8,
            },
          ]}
        >
          <Text numberOfLines={1} style={[styles.meta, { flex: 1, color: c.text }]}>
            {preview}
          </Text>
          {row.content?.attachments.length ? (
            <View style={[styles.row, { gap: 2 }]} accessibilityLabel={`${row.content.attachments.length} attachments`}>
              <Icon name="paper-clip" size={14} />
              <Text style={[styles.meta, { color: c.muted }]}>{row.content.attachments.length}</Text>
            </View>
          ) : null}
          <Text numberOfLines={1} style={[styles.meta, { maxWidth: 70, color: c.muted, flexShrink: 1 }]}>
            {row.deviceName}
          </Text>
          <Text numberOfLines={1} style={[styles.meta, { color: c.muted }]}>
            {formatRelative(timestampFromMs(Number(row.updatedAtMs)))}
          </Text>
        </Pressable>
        <IconButton icon="x-mark" label="Discard draft" size="sm" disabled={disabled} onPress={onDiscard} />
      </View>
      {selected ? (
        <View style={[styles.row, { justifyContent: "flex-end", flexWrap: "wrap", gap: 4 }]}>
          <Button title="Append draft" size="sm" variant="ghost" disabled={disabled} onPress={() => onTake(false)} />
          <Button
            title="Replace local draft"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onPress={() => onTake(true)}
          />
        </View>
      ) : null}
    </View>
  );
}
