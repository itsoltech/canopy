import type { ReactNode } from "react";
import { Modal, useWindowDimensions } from "react-native";
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
  children,
}: {
  visible: boolean;
  onClose: () => void;
  /** Runs after the exit animation and native modal dismissal, including on Android. */
  onDismiss?: () => void;
  label: string;
  children: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const presented = useKeyboardPresentation(visible);
  const { progress, mounted, didDismiss } = useOverlayTransition(presented, width >= WIDE_OVERLAY, onDismiss);

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
      onDismiss={didDismiss}
    >
      <KeyboardWindow preload={false}>
        <OverlaySurface
          visible={visible}
          onClose={onClose}
          label={label}
          progress={progress}
          wide={width >= WIDE_OVERLAY}
        >
          {children}
        </OverlaySurface>
      </KeyboardWindow>
    </Modal>
  );
}
