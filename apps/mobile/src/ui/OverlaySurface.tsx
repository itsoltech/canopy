import type { ReactNode } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import Animated, {
  LayoutAnimationConfig,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { useKeyboardFrame } from "./KeyboardWindow";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SheetHandle, SheetDragContext } from "./SheetDragArea";
import { useSheetGesture } from "./useSheetGesture";
import { useColors } from "./theme";

/** The scrim fills the window independently of keyboard padding. Phone sheets never scale away from its edges. */
export function OverlaySurface({
  visible,
  onClose,
  label,
  progress,
  velocity,
  wide,
  fullHeight,
  onLayout,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  label: string;
  progress: SharedValue<number>;
  velocity: SharedValue<number>;
  wide: boolean;
  fullHeight: boolean;
  onLayout: () => void;
  children: ReactNode;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const keyboard = useKeyboardFrame();
  const sheetHeight = useSharedValue(height);

  const travel = useDerivedValue(() =>
    Math.max(1, (wide ? (height + sheetHeight.get()) / 2 : sheetHeight.get()) - keyboard.height.get() + 24),
  );

  const handlers = useSheetGesture(progress, velocity, travel, sheetHeight, visible, onClose);
  const scrim = useAnimatedStyle(() => ({ opacity: Math.max(0, Math.min(1, progress.get())) }));

  const viewport = useAnimatedStyle(() => ({
    paddingBottom: wide ? Math.max(-keyboard.height.get(), insets.bottom) : -keyboard.height.get(),
  }));

  const surface = useAnimatedStyle(() => {
    const t = progress.get();
    const available = height + keyboard.height.get() - insets.top;

    return {
      maxHeight: Math.max(0, available * (fullHeight ? 0.94 : wide ? 0.7 : 0.85)),
      paddingBottom: 8 + (wide ? 0 : insets.bottom * (1 - keyboard.progress.get())),
      transform: [{ translateY: (1 - t) * travel.get() }],
    };
  });

  return (
    <SheetDragContext.Provider value={{ handlers, close: onClose }}>
      <View pointerEvents={visible ? "auto" : "none"} style={{ flex: 1 }}>
        <Animated.View style={[{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }, scrim]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Close ${label}`}
            onPress={onClose}
            style={{ flex: 1, backgroundColor: c.scrim }}
          />
        </Animated.View>
        <Animated.View
          pointerEvents="box-none"
          style={[
            {
              flex: 1,
              paddingTop: insets.top,
              paddingLeft: wide ? insets.left : 0,
              paddingRight: wide ? insets.right : 0,
              justifyContent: wide ? "center" : "flex-end",
              alignItems: "center",
            },
            viewport,
          ]}
        >
          <Animated.View
            accessibilityViewIsModal
            accessibilityLabel={label}
            onAccessibilityEscape={onClose}
            onLayout={(event) => {
              sheetHeight.set(event.nativeEvent.layout.height);
              onLayout();
            }}
            style={[
              {
                width: wide ? Math.min(fullHeight ? 640 : 420, width - insets.left - insets.right - 48) : "100%",
                height: fullHeight ? "100%" : undefined,
                marginHorizontal: wide ? 24 : 0,
                paddingLeft: wide ? 0 : insets.left,
                paddingRight: wide ? 0 : insets.right,
                borderRadius: 16,
                borderBottomLeftRadius: wide ? 16 : 0,
                borderBottomRightRadius: wide ? 16 : 0,
                backgroundColor: c.overlay,
                borderWidth: c.dark ? 1 : 0,
                borderBottomWidth: wide && c.dark ? 1 : 0,
                borderColor: c.line,
                shadowColor: "#000000",
                shadowOpacity: 0.2,
                shadowRadius: 24,
                shadowOffset: { width: 0, height: 8 },
                elevation: 12,
              },
              surface,
            ]}
          >
            {!wide && (
              <View
                pointerEvents="none"
                style={{ position: "absolute", top: "100%", left: 0, right: 0, height, backgroundColor: c.overlay }}
              />
            )}
            <SheetHandle />
            <LayoutAnimationConfig skipEntering skipExiting>
              {children}
            </LayoutAnimationConfig>
          </Animated.View>
        </Animated.View>
      </View>
    </SheetDragContext.Provider>
  );
}
