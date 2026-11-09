import { createContext, useContext, type ReactNode } from "react";
import { View, type GestureResponderHandlers, type ViewProps } from "react-native";
import { IconButton } from "./Button";
import { useColors } from "./theme";

export const SheetDragContext = createContext<{ handlers: GestureResponderHandlers; close: () => void }>({
  handlers: {},
  close: () => {},
});

/** Only chrome opts into dragging; text inputs and native scroll views keep their own responders. */
export function SheetDragArea({ children, ...props }: ViewProps & { children: ReactNode }) {
  const { handlers } = useContext(SheetDragContext);

  return (
    <View {...props} {...handlers}>
      {children}
    </View>
  );
}

/** Wait for the shared exit before notifying a parent that may unmount the entire sheet. */
export function SheetCloseButton({ label }: { label: string }) {
  const { close } = useContext(SheetDragContext);

  return <IconButton icon="x-mark" size="sm" label={label} onPress={close} />;
}

export function SheetHandle() {
  const { close } = useContext(SheetDragContext);
  const c = useColors();

  return (
    <SheetDragArea
      accessible
      accessibilityRole="button"
      accessibilityLabel="Close"
      accessibilityHint="Drag down to close."
      accessibilityActions={[
        { name: "activate", label: "Close" },
        { name: "dismiss", label: "Close" },
      ]}
      onAccessibilityAction={close}
      onAccessibilityTap={close}
      onAccessibilityEscape={close}
      hitSlop={8}
      style={{ alignItems: "center", justifyContent: "center", height: 28 }}
    >
      <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: c.line }} />
    </SheetDragArea>
  );
}
