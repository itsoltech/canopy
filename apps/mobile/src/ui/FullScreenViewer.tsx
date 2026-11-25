import { useLayoutEffect, type ReactNode } from "react";
import { Modal, StyleSheet, Text, type ModalProps } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { IconButton } from "./Button";
import { CompactControls } from "./density";
import { useMotion } from "./motion";
import { OverlayOrientations, registerFullScreenViewer } from "./overlay-stack";
import { styles, useColors } from "./theme";

/**
 * Mounted only while open. Full opacity covers the underlying timeline, including every safe-area edge. With
 * `fade` (1 = opaque) the backdrop and header follow it, so a dismiss gesture reveals the timeline underneath.
 */
export function FullScreenViewer({
  title,
  onClose,
  closeLabel = "Close viewer",
  onRequestClose = onClose,
  supportedOrientations,
  actions,
  fade,
  children,
}: {
  title: string;
  onClose: () => void;
  closeLabel?: string;
  onRequestClose?: () => void;
  supportedOrientations?: ModalProps["supportedOrientations"];
  actions?: ReactNode;
  fade?: SharedValue<number>;
  children: ReactNode;
}) {
  const c = useColors();
  const { reveal } = useMotion();
  const opacity = useAnimatedStyle(() => ({ opacity: fade ? fade.get() : 1 }));
  useLayoutEffect(registerFullScreenViewer, []);

  return (
    <Modal
      visible
      transparent={!!fade}
      animationType="none"
      presentationStyle={fade ? "overFullScreen" : "fullScreen"}
      onRequestClose={onRequestClose}
      supportedOrientations={supportedOrientations}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.background }, opacity]} />
          <SafeAreaView style={{ flex: 1 }}>
            <Animated.View entering={reveal.entering} accessibilityViewIsModal style={{ flex: 1 }}>
              <Animated.View
                style={[
                  styles.row,
                  { paddingHorizontal: 8, minHeight: 48, borderBottomWidth: 1, borderColor: c.rule },
                  opacity,
                ]}
              >
                <IconButton icon="x-mark" label={closeLabel} onPress={onClose} />
                <Text numberOfLines={1} style={[styles.chrome, { flex: 1, minWidth: 0, color: c.text }]}>
                  {title}
                </Text>
                <CompactControls.Provider value={true}>{actions}</CompactControls.Provider>
              </Animated.View>
              <OverlayOrientations.Provider value={supportedOrientations}>{children}</OverlayOrientations.Provider>
            </Animated.View>
          </SafeAreaView>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </Modal>
  );
}
