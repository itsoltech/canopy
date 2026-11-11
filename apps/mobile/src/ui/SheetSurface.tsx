import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { Overlay } from "./Overlay";
import { SheetDragArea } from "./SheetDragArea";
import { ContentInsets, PaneInsets } from "./ScreenFrame";

const contentInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Modal safe areas belong to the modal window, independently of the sidebar beneath it. */
export function SheetSurface({
  visible,
  onClose,
  label,
  header,
  children,
  scroll = true,
  footer,
}: {
  visible: boolean;
  onClose: () => void;
  label: string;
  header: ReactNode;
  children: ReactNode;
  scroll?: boolean;
  footer?: ReactNode;
}) {
  return (
    <Overlay visible={visible} onClose={onClose} label={label} fullHeight>
      <PaneInsets.Provider value={contentInsets}>
        <ContentInsets.Provider value={contentInsets}>
          <SheetDragArea>{header}</SheetDragArea>
          {scroll ? (
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentInsetAdjustmentBehavior="never"
              automaticallyAdjustContentInsets={false}
              contentContainerStyle={{ padding: 20, gap: 16, width: "100%", maxWidth: 600, alignSelf: "center" }}
            >
              {children}
            </ScrollView>
          ) : (
            <View style={{ flex: 1, minHeight: 0 }}>{children}</View>
          )}
          {footer}
        </ContentInsets.Provider>
      </PaneInsets.Provider>
    </Overlay>
  );
}
