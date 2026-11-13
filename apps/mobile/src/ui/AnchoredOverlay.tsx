import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type ComponentRef,
} from "react";
import { AccessibilityInfo, View } from "react-native";
import Animated, { useAnimatedRef, type AnimatedRef } from "react-native-reanimated";
import type { EdgeInsets } from "react-native-safe-area-context";
import { AnchoredSurface } from "./AnchoredSurface";

export interface AnchoredContent {
  id: string;
  anchor: AnimatedRef<ComponentRef<typeof View>>;
  label: string;
  onClose: () => void;
  children: ReactNode;
  modal: boolean;
  maxHeight: number;
  disclosure: boolean;
}

const Portal = createContext<{
  show: (content: AnchoredContent, opening: boolean) => void;
  remove: (id: string) => void;
} | null>(null);

/** A portal in the current native window: it never dismisses or replaces the composer's keyboard. */
export function AnchoredOverlayHost({ children, insets }: { children: ReactNode; insets: EdgeInsets }) {
  const host = useAnimatedRef<ComponentRef<typeof View>>();
  const [content, setContent] = useState<AnchoredContent>();
  const active = useRef<AnchoredContent>(undefined);

  const portal = useMemo(
    () => ({
      show: (next: AnchoredContent, opening: boolean) => {
        // Live updates refresh their own panel; only a new opening may replace another overlay.
        if (active.current?.id !== next.id) {
          if (!opening) return;
          active.current?.onClose();
        }

        active.current = next;
        setContent(next);
      },
      remove: (id: string) => {
        if (active.current?.id !== id) return;
        active.current = undefined;
        setContent(undefined);
      },
    }),
    [],
  );

  return (
    <Portal.Provider value={portal}>
      <Animated.View ref={host} collapsable={false} style={{ flex: 1 }}>
        <View
          style={{ flex: 1 }}
          accessibilityElementsHidden={content?.modal}
          importantForAccessibility={content?.modal ? "no-hide-descendants" : "auto"}
        >
          {children}
        </View>
        {content && <AnchoredSurface key={content.id} content={content} host={host} insets={insets} />}
      </Animated.View>
    </Portal.Provider>
  );
}

/** The anchor always keeps its natural size. Only the host subscribes to the portalled content. */
export function AnchoredOverlay({
  visible,
  onClose,
  label,
  children,
  anchor,
  modal = true,
  maxHeight = 320,
  disclosure = false,
  triggerRef,
}: {
  visible: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  anchor?: ReactNode;
  modal?: boolean;
  maxHeight?: number;
  /** Composer trays reveal their height upward without changing the feed reserve. */
  disclosure?: boolean;
  triggerRef?: RefObject<ComponentRef<typeof View> | null>;
}) {
  const portal = useContext(Portal);
  const ref = useAnimatedRef<ComponentRef<typeof View>>();
  const id = useId();
  const wasVisible = useRef(false);
  const published = useRef(false);

  if (!portal) throw new Error("Anchored overlays require a ScreenFrame.");

  useLayoutEffect(() => {
    if (visible)
      portal.show({ id, anchor: ref, label, onClose, children, modal, maxHeight, disclosure }, !published.current);
    else portal.remove(id);
    published.current = visible;
  }, [portal, visible, id, ref, label, onClose, children, modal, maxHeight, disclosure]);

  useLayoutEffect(
    () => () => {
      published.current = false;
      portal.remove(id);
    },
    [portal, id],
  );

  useEffect(() => {
    const restore = wasVisible.current && !visible && modal;
    wasVisible.current = visible;

    if (!restore) return;

    const frame = requestAnimationFrame(() => {
      if (triggerRef?.current) AccessibilityInfo.sendAccessibilityEvent(triggerRef.current, "focus");
    });

    return () => cancelAnimationFrame(frame);
  }, [visible, modal, triggerRef]);

  return (
    <Animated.View ref={ref} collapsable={false}>
      {anchor}
    </Animated.View>
  );
}
