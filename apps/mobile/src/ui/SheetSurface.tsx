import type { ReactNode } from "react";
import { Modal } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ScreenFrame } from "./ScreenFrame";
import { ScreenScroll } from "./ScreenScroll";
import { KeyboardViewport } from "./KeyboardViewport";
import { KeyboardWindow } from "./KeyboardWindow";
import { useReducedMotion } from "./motion";
import { useColors } from "./theme";
import { useKeyboardPresentation } from "./useKeyboardPresentation";

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
  const presented = useKeyboardPresentation(visible);

  return (
    <Modal
      visible={presented}
      animationType={reduced ? "none" : "slide"}
      presentationStyle="pageSheet"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <SafeAreaProvider>
        <KeyboardWindow preload={false}>
          <ScreenFrame fullWindow backgroundColor={c.surface} header={header}>
            <KeyboardViewport>
              <ScreenScroll space={20} keyboardShouldPersistTaps="handled" contentContainerStyle={{ maxWidth: 600 }}>
                {children}
              </ScreenScroll>
            </KeyboardViewport>
          </ScreenFrame>
        </KeyboardWindow>
      </SafeAreaProvider>
    </Modal>
  );
}
