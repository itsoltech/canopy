import { useCallback, useContext, useId, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Modal, useWindowDimensions } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardWindow } from "./KeyboardWindow";
import { OverlaySurface } from "./OverlaySurface";
import { useOverlayTransition } from "./useOverlayTransition";
import { useKeyboardPresentation } from "./useKeyboardPresentation";
import { mayPresent, OverlayLayer, overlayNested, OverlayParent, setOverlay, subscribeOverlays } from "./overlay-stack";

/** Window width from which overlays open as centered cards. */
export const WIDE_OVERLAY = 600;

/** Keeps the overlay's place among its siblings current; see `mayPresent`. */
function useOverlayEntry(id: string, phase: "waiting" | "shown" | "closing" | undefined, host: boolean) {
  const parent = useContext(OverlayParent);

  useLayoutEffect(() => {
    setOverlay(id, phase && { parent, phase, host });
  }, [id, parent, phase, host]);

  useLayoutEffect(() => () => setOverlay(id, undefined), [id]);
}

/** Dismiss the previous window's keyboard before presenting; a searchable picker owns its own keyboard. */
export function Overlay({
  visible,
  onClose,
  onDismiss,
  label,
  fullHeight = false,
  layer = true,
  children,
}: {
  visible: boolean;
  /** Shared close controls notify the parent after the exit and native dismissal. */
  onClose: () => void;
  /** Runs after the exit animation and native modal dismissal, including on Android. */
  onDismiss?: () => void;
  label: string;
  fullHeight?: boolean;
  /** Shared dialogs (confirmations) may present above this overlay. */
  layer?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const { width } = useWindowDimensions();
  const [closing, setClosing] = useState(false);
  const close = useCallback(() => setClosing(true), []);
  const presented = useKeyboardPresentation(visible);
  const allowed = useSyncExternalStore(subscribeOverlays, () => mayPresent(id));
  const nested = useSyncExternalStore(subscribeOverlays, () => overlayNested(id));
  const Layer = useContext(OverlayLayer);

  const { progress, velocity, mounted, native, attached, didDismiss, didLayout } = useOverlayTransition(
    presented && !closing && allowed,
    () => {
      if (closing) onClose();
      onDismiss?.();
    },
    nested,
  );

  const [content, setContent] = useState({ children });
  const shown = mounted && visible && !closing;
  useOverlayEntry(id, attached ? (shown ? "shown" : "closing") : visible && !closing ? "waiting" : undefined, layer);

  if (!visible && closing) setClosing(false);

  if (visible && content.children !== children) setContent({ children });

  return (
    <Modal
      visible={native}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={close}
      onDismiss={didDismiss}
    >
      <OverlayParent.Provider value={id}>
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
          {layer && Layer && <Layer host={id} />}
        </SafeAreaProvider>
      </OverlayParent.Provider>
    </Modal>
  );
}
