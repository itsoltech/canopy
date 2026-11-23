import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { useAnimatedScrollHandler, useDerivedValue, useSharedValue } from "react-native-reanimated";
import { useContentInsets } from "../../ui/ScreenFrame";
import { styles, useColors } from "../../ui/theme";
import { ConnectionBanner } from "./ConnectionStatus";
import { SidebarBrand, SidebarGradient, SidebarWatermark } from "./SidebarBrand";

/** The scroll view docks one brand row above the visible pane so the toolbar pins at its safe edge. */
export function useSidebarListHeader(
  viewportHeight: number,
  renderControls: (beforeSwitch: (searchFocused: boolean) => void, focusSearch: boolean) => ReactNode,
) {
  const insets = useContentInsets();
  const c = useColors();
  const [brandHeight, setBrandHeight] = useState(48);
  const [headerHeight, setHeaderHeight] = useState(0);

  const [start, setStart] = useState({ y: 0, focusSearch: false });
  const offset = useSharedValue(0);
  const scroll = useAnimatedScrollHandler((event) => offset.set(event.contentOffset.y));
  const listTop = useDerivedValue(() => headerHeight + Math.max(0, brandHeight - offset.get()));

  // A fresh list opens at its first rows with the same amount of brand visible.
  function beforeSwitch(searchFocused: boolean) {
    setStart({
      y: Math.max(0, Math.min(brandHeight, offset.get())),
      focusSearch: searchFocused,
    });
  }

  const header = (
    <View
      onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
      style={{ paddingBottom: 8, backgroundColor: c.sidebar }}
    >
      <View style={{ overflow: "hidden" }}>
        <SidebarGradient topInset={insets.top} offset={-insets.top} />
        <SidebarWatermark />
        <View
          onLayout={(event) => setBrandHeight(event.nativeEvent.layout.height)}
          style={[styles.row, { minHeight: 48, paddingLeft: 16, paddingRight: 8 }]}
        >
          <SidebarBrand />
        </View>
        {renderControls(beforeSwitch, start.focusSearch)}
      </View>
      <ConnectionBanner />
    </View>
  );

  return {
    brandHeight,
    offset,
    listTop,
    listProps: {
      ListHeaderComponent: header,
      ListHeaderComponentStyle: { marginHorizontal: -8 },
      stickyHeaderIndices: [0],
      contentOffset: { x: 0, y: start.y },
      onScroll: scroll,
      scrollEventThrottle: 16,
      scrollIndicatorInsets: { top: brandHeight },
      // Android otherwise scrolls back to the original layout position of the already visible search field.
      scrollsChildToFocus: false,
      keyboardShouldPersistTaps: "handled" as const,
      automaticallyAdjustContentInsets: false,
      contentInsetAdjustmentBehavior: "never" as const,
      // Keep the translated sticky cell attached after its original position leaves the Android viewport.
      removeClippedSubviews: false,
      contentContainerStyle: {
        paddingHorizontal: 8,
        paddingTop: brandHeight,
        // Short lists can scroll the full brand away. Keep Archived above the footer at rest.
        paddingBottom: insets.bottom + 8 + brandHeight,
        minHeight: viewportHeight + brandHeight,
      },
    },
  };
}

export type SidebarListHeader = ReturnType<typeof useSidebarListHeader>;
