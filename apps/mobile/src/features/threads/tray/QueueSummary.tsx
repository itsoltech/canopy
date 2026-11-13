import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { queuePreview } from "@canopy/domain/queue";
import { Icon } from "../../../ui/Icon";
import { Overlay } from "../../../ui/Overlay";
import { SheetCloseButton, SheetDragArea } from "../../../ui/SheetDragArea";
import { styles, useColors } from "../../../ui/theme";
import { TRAY_ROW } from "./TrayHeader";

/** Muted counts in the queue; names stay in a scrollable sheet instead of changing row height. */
export function QueueSummary({ preview }: { preview: ReturnType<typeof queuePreview> }) {
  const c = useColors();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Show message content: ${preview.summary}`}
        onPress={() => setOpen(true)}
        hitSlop={{ top: 4, bottom: 4 }}
        style={({ pressed }) => ({
          minHeight: TRAY_ROW,
          minWidth: 0,
          maxWidth: preview.text ? "50%" : "100%",
          flexShrink: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 4,
          borderRadius: 6,
          backgroundColor: pressed ? c.pressed : "transparent",
        })}
      >
        <Icon name="paper-clip" size={16} color={c.muted} />
        <Text numberOfLines={1} style={[styles.overlayMeta, { flexShrink: 1, color: c.muted }]}>
          {preview.summary}
        </Text>
      </Pressable>
      <Overlay visible={open} onClose={() => setOpen(false)} label="Message content">
        <SheetDragArea style={[styles.row, { paddingHorizontal: 12, paddingTop: 4 }]}>
          <Text accessibilityRole="header" style={[styles.overlayHeading, { flex: 1, color: c.muted }]}>
            Message content
          </Text>
          <SheetCloseButton label="Close message content" />
        </SheetDragArea>
        <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 12, gap: 12 }}>
          {preview.items.map((item, index) => (
            <View key={index} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
              <Icon
                name={
                  item.kind === "image"
                    ? "photo"
                    : item.kind === "citation"
                      ? "chat-bubble-bottom-center-text"
                      : "document-text"
                }
                size={16}
                color={c.muted}
              />
              <Text selectable style={[styles.overlayMeta, { flex: 1, minWidth: 0, color: c.text }]}>
                {item.label}
              </Text>
            </View>
          ))}
        </ScrollView>
      </Overlay>
    </>
  );
}
