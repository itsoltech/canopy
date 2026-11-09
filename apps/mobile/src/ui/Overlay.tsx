import { useCallback, useState, type ReactNode } from "react";
import { Modal, useWindowDimensions } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardWindow } from "./KeyboardWindow";
import { OverlaySurface } from "./OverlaySurface";
import { useOverlayTransition } from "./useOverlayTransition";
import { useKeyboardPresentation } from "./useKeyboardPresentation";

/** Window width from which overlays open as centered cards. */
export const WIDE_OVERLAY = 600;

/** Dismiss the previous window's keyboard before presenting; a searchable picker owns its own keyboard. */
export function Overlay({
  visible,
  onClose,
  onDismiss,
  label,
  fullHeight = false,
  children,
}: {
  visible: boolean;
  /** Shared close controls notify the parent after the exit and native dismissal. */
  onClose: () => void;
  /** Runs after the exit animation and native modal dismissal, including on Android. */
  onDismiss?: () => void;
  label: string;
  fullHeight?: boolean;
  children: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const [closing, setClosing] = useState(false);
  const close = useCallback(() => setClosing(true), []);
  const presented = useKeyboardPresentation(visible);

  const { progress, velocity, mounted, didDismiss, didLayout } = useOverlayTransition(presented && !closing, () => {
    if (closing) onClose();
    onDismiss?.();
  });

  const [content, setContent] = useState({ children });

  if (!visible && closing) setClosing(false);

  if (visible && content.children !== children) setContent({ children });

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={close}
      onDismiss={didDismiss}
    >
      <SafeAreaProvider>
        <KeyboardWindow preload={false}>
          <OverlaySurface
            visible={visible && !closing}
            onClose={close}
            label={label}
            progress={progress}
            velocity={velocity}
            wide={width >= WIDE_OVERLAY}
            fullHeight={fullHeight}
            onLayout={didLayout}
          >
            {visible ? children : content.children}
          </OverlaySurface>
        </KeyboardWindow>
      </SafeAreaProvider>
    </Modal>
  );
}
