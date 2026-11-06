import type { ReactNode } from "react";
import { Modal } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ScreenFrame } from "./ScreenFrame";
import { ScreenScroll } from "./ScreenScroll";
import { KeyboardArea } from "./KeyboardArea";
import { useReducedMotion } from "./motion";
import { useColors } from "./theme";

/** Modal safe areas belong to the modal window, independently of the sidebar beneath it. */
export function SheetSurface({
  visible,
  onClose,
  header,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  header: ReactNode;
  children: ReactNode;
}) {
  const c = useColors();
  const reduced = useReducedMotion();

  return (
    <Modal
      visible={visible}
      animationType={reduced ? "none" : "slide"}
      presentationStyle="pageSheet"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <SafeAreaProvider>
        <ScreenFrame fullWindow backgroundColor={c.surface} header={header}>
          <KeyboardArea>
            <ScreenScroll space={20} keyboardShouldPersistTaps="handled" contentContainerStyle={{ maxWidth: 600 }}>
              {children}
            </ScreenScroll>
          </KeyboardArea>
        </ScreenFrame>
      </SafeAreaProvider>
    </Modal>
  );
}
