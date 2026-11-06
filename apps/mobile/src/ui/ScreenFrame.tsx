import { createContext, useContext, useState, type ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets, type EdgeInsets } from "react-native-safe-area-context";
import { useColors } from "./theme";

/** Only the outside edges of a split window need horizontal safe-area padding. */
export const PaneInsets = createContext<Pick<EdgeInsets, "left" | "right"> | null>(null);
export const ContentInsets = createContext<EdgeInsets | null>(null);

export function usePaneInsets() {
  const window = useSafeAreaInsets();
  const pane = useContext(PaneInsets);

  return { ...window, ...pane };
}

export function useContentInsets() {
  const pane = usePaneInsets();

  return useContext(ContentInsets) ?? pane;
}

/** Padding belongs to scroll content, so rows can pass underneath the floating chrome. */
export function useContentPadding(space = 16) {
  const insets = useContentInsets();

  return {
    paddingTop: insets.top + space,
    paddingBottom: insets.bottom + space,
    paddingLeft: insets.left + space,
    paddingRight: insets.right + space,
  };
}

/** Full-window background and scroller, measured floating chrome, and safe controls. */
export function ScreenFrame({
  children,
  header,
  footer,
  backgroundColor,
  fullWindow = false,
}: {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  backgroundColor?: string;
  fullWindow?: boolean;
}) {
  const c = useColors();
  const window = useSafeAreaInsets();
  const pane = usePaneInsets();
  const insets = fullWindow ? window : pane;

  const [headerSize, setHeaderSize] = useState(48);
  const [footerSize, setFooterSize] = useState(0);
  const background = backgroundColor ?? c.background;

  const content = {
    ...insets,
    top: insets.top + (header ? headerSize : 0),
    bottom: insets.bottom + (footer ? footerSize : 0),
  };

  return (
    <PaneInsets.Provider value={insets}>
      <ContentInsets.Provider value={content}>
        <View style={{ flex: 1, backgroundColor: background }}>
          {children}
          {header && (
            <View
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                paddingTop: insets.top,
                paddingLeft: insets.left,
                paddingRight: insets.right,
                backgroundColor: `${background}f2`,
              }}
            >
              <View onLayout={(event) => setHeaderSize(event.nativeEvent.layout.height)}>{header}</View>
            </View>
          )}
          {footer && (
            <View
              style={{
                position: "absolute",
                bottom: 0,
                left: 0,
                right: 0,
                paddingBottom: insets.bottom,
                paddingLeft: insets.left,
                paddingRight: insets.right,
                backgroundColor: `${background}f2`,
              }}
            >
              <View onLayout={(event) => setFooterSize(event.nativeEvent.layout.height)}>{footer}</View>
            </View>
          )}
        </View>
      </ContentInsets.Provider>
    </PaneInsets.Provider>
  );
}
