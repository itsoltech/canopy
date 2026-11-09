import type { ReactNode } from "react";
import { Modal, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";
import { IconButton } from "./Button";
import { CompactControls } from "./density";
import { useMotion } from "./motion";
import { styles, useColors } from "./theme";

/** Mounted only while open. Full opacity covers the underlying timeline, including every safe-area edge. */
export function FullScreenViewer({
  title,
  onClose,
  actions,
  children,
}: {
  title: string;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const c = useColors();
  const { reveal } = useMotion();

  return (
    <Modal visible animationType="none" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.background }}>
        <Animated.View entering={reveal.entering} accessibilityViewIsModal style={{ flex: 1 }}>
          <View
            style={[styles.row, { paddingHorizontal: 8, minHeight: 48, borderBottomWidth: 1, borderColor: c.rule }]}
          >
            <IconButton icon="x-mark" label="Close viewer" onPress={onClose} />
            <Text numberOfLines={1} style={[styles.chrome, { flex: 1, minWidth: 0, color: c.text }]}>
              {title}
            </Text>
            <CompactControls.Provider value={true}>{actions}</CompactControls.Provider>
          </View>
          {children}
        </Animated.View>
      </SafeAreaView>
    </Modal>
  );
}
