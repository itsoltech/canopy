import type { ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { useColors } from "../../ui/theme";
import { IconButton } from "../../ui/components";
import { useContentInsets } from "../../ui/ScreenFrame";

/** Web VirtualFeed's bottom overlay: canvas fading over 32 points, with the timeline continuing underneath. */
export function FloatingComposer({
  children,
  onLayout,
  onExpand,
  onLatest,
}: {
  children: ReactNode;
  onLayout: (event: LayoutChangeEvent) => void;
  onExpand: () => void;
  onLatest?: (() => void) | undefined;
}) {
  const c = useColors();
  const insets = useContentInsets();

  return (
    <View pointerEvents="box-none" style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}>
      {onLatest && (
        <View pointerEvents="box-none" style={{ height: 56, alignItems: "center" }}>
          <View
            style={{
              borderRadius: 22,
              backgroundColor: c.surface,
              borderWidth: 1,
              borderColor: c.line,
              boxShadow: "0px 2px 8px #0000001a",
            }}
          >
            <IconButton icon="arrow-down" label="Show latest messages" onPress={onLatest} />
          </View>
        </View>
      )}
      <View
        onLayout={onLayout}
        onTouchStart={onExpand}
        style={{
          paddingLeft: 12 + insets.left,
          paddingRight: 12 + insets.right,
          paddingTop: 8,
          paddingBottom: 12 + insets.bottom,
          gap: 8,
        }}
      >
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: -32,
            bottom: 0,
            left: 0,
            right: 0,
            backgroundImage: `linear-gradient(to bottom, ${c.background}00, ${c.background} 32px)`,
          }}
        />
        {children}
      </View>
    </View>
  );
}
