import type { ReactNode } from "react";
import { ScrollView, Text } from "react-native";
import { Overlay } from "../../../ui/Overlay";
import { SheetCloseButton, SheetDragArea } from "../../../ui/SheetDragArea";
import { styles, useColors } from "../../../ui/theme";

/** Tray lists use the app's phone sheet and wide-window card, independently of the composer's geometry. */
export function TraySheet({
  title,
  visible,
  onClose,
  onDismiss,
  children,
}: {
  title: string;
  visible: boolean;
  onClose: () => void;
  onDismiss?: () => void;
  children: ReactNode;
}) {
  const c = useColors();

  return (
    <Overlay visible={visible} onClose={onClose} onDismiss={onDismiss} label={title}>
      <SheetDragArea
        style={[
          styles.row,
          { paddingLeft: 16, paddingRight: 8, paddingBottom: 8, borderBottomWidth: 1, borderColor: c.rule },
        ]}
      >
        <Text accessibilityRole="header" numberOfLines={2} style={[styles.overlayHeading, { flex: 1, color: c.text }]}>
          {title}
        </Text>
        <SheetCloseButton label={`Close ${title.toLowerCase()}`} />
      </SheetDragArea>
      <ScrollView
        bounces={false}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        style={{ flexGrow: 0, flexShrink: 1 }}
        contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 4 }}
      >
        {children}
      </ScrollView>
    </Overlay>
  );
}
