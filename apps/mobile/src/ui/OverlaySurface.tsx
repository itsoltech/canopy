import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import Animated, { LayoutAnimationConfig, type SharedValue } from "react-native-reanimated";
import { SheetHandle, SheetDragContext } from "./SheetDragArea";
import { useSheetGesture } from "./useSheetGesture";
import { useSheetLayout } from "./useSheetLayout";
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
  snap,
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
  snap: boolean;
  children: ReactNode;
}) {
  const c = useColors();

  const { width, height, insets, sheetHeight, offset, travel, scrim, viewport, surface, body } = useSheetLayout(
    progress,
    wide,
    fullHeight,
    snap,
  );

  const handlers = useSheetGesture(progress, velocity, travel, sheetHeight, visible, onClose, offset, snap && !wide);

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
            <Animated.View style={[{ minHeight: 0, overflow: "hidden" }, body]}>
              <SheetHandle />
              <LayoutAnimationConfig skipEntering skipExiting>
                {children}
              </LayoutAnimationConfig>
            </Animated.View>
          </Animated.View>
        </Animated.View>
      </View>
    </SheetDragContext.Provider>
  );
}
