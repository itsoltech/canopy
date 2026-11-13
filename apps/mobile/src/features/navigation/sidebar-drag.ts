import { createContext, useContext, useEffect, useMemo } from "react";
import type { FlatList } from "react-native";
import { GestureStateManager, usePanGesture } from "react-native-gesture-handler";
import {
  measure,
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useFrameCallback,
  useSharedValue,
  type FrameInfo,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type Animated from "react-native-reanimated";
import { useAppActive } from "../../ui/active";
import type { SidebarEntry } from "@canopy/domain/sidebar-entries";
import type { useSidebarOrder } from "./sidebar-order";
import { dropAt, rowAt, type DragItem, type RowBox } from "./sidebar-drag-target";

export type SidebarListEntry = SidebarEntry & { section: "active" | "archived" | "heading" | "status" | "empty" };

function withinWidth(bounds: { left: number; right: number }, x: number) {
  "worklet";

  return x >= bounds.left && x <= bounds.right;
}

/** Register frames only for a live drag; a late JS start must not revive a finalized or suspended gesture. */
function useDragLoop(enabled: boolean, active: SharedValue<string>, tick: (time: FrameInfo) => void) {
  const loop = useFrameCallback(tick, false);

  useEffect(() => {
    if (!enabled) loop.setActive(false);

    return () => {
      loop.setActive(false);
      active.set("");
    };
  }, [loop, enabled, active]);

  return (running: boolean) => loop.setActive(running && !!active.get());
}

export function useSidebarDrag(
  items: Record<string, DragItem>,
  grouped: boolean,
  enabled: boolean,
  order: ReturnType<typeof useSidebarOrder>,
) {
  const list = useAnimatedRef<FlatList<SidebarListEntry>>();
  const frame = useAnimatedRef<Animated.View>();
  const boxes = useSharedValue<Record<string, RowBox>>({});
  const pickups = useSharedValue<Record<string, number>>({});
  const rows = useSharedValue(items);
  const active = useSharedValue("");
  const pending = useSharedValue("");
  const pointer = useSharedValue(0);
  const horizontal = useSharedValue({ left: 0, right: 0 });
  const insideX = useSharedValue(true);
  const grab = useSharedValue(0);
  const offset = useSharedValue(0);
  const top = useSharedValue(0);
  const height = useSharedValue(0);
  const content = useSharedValue(0);
  const pin = useSharedValue(false);
  const target = useSharedValue({ id: "", before: true, line: -1 });
  const appActive = useAppActive();
  const { drop } = order;

  useEffect(() => {
    rows.set(items);
  }, [rows, items]);
  useEffect(() => {
    if (!enabled || !appActive) active.set("");
  }, [enabled, appActive, active]);

  const scroll = useAnimatedScrollHandler((event) => offset.set(event.contentOffset.y));

  const setLoopActive = useDragLoop(enabled && appActive, active, (time) => {
    "worklet";

    if (!active.get()) return;
    const y = pointer.get();
    const extent = height.get();
    const inside = insideX.get() && y >= 0 && y <= extent;
    pin.set(inside && y < 48);
    target.set(
      inside
        ? dropAt(boxes.get(), rows.get(), active.get(), y + offset.get(), grouped)
        : { id: "", before: true, line: -1 },
    );
    const edge = !inside ? 0 : y < 48 ? -1 : y > extent - 48 ? 1 : 0;

    const next = Math.max(
      0,
      Math.min(
        Math.max(0, content.get() - extent),
        offset.get() + edge * Math.min(32, time.timeSincePreviousFrame ?? 16) * 0.48,
      ),
    );

    if (edge && next !== offset.get()) scrollTo(list, 0, next, false);
  });

  const gesture = usePanGesture({
    enabled: enabled && appActive,
    activateAfterLongPress: 350,
    minDistance: 6,
    maxPointers: 1,
    onBegin: (event) => {
      "worklet";
      const bounds = measure(frame);

      if (!bounds) {
        GestureStateManager.fail(event.handlerTag);

        return;
      }

      top.set(bounds.pageY);
      height.set(bounds.height);
      horizontal.set({ left: bounds.pageX, right: bounds.pageX + bounds.width });
      insideX.set(true);
      const y = event.absoluteY - bounds.pageY;
      const id = rowAt(boxes.get(), y + offset.get());
      const box = boxes.get()[id];
      const pickupHeight = pickups.get()[id] ?? 0;

      if (!rows.get()[id]?.local || !box || y + offset.get() - box.top >= pickupHeight) {
        GestureStateManager.fail(event.handlerTag);

        return;
      }

      pending.set(id);
      target.set({ id: "", before: true, line: -1 });
      pin.set(false);
      grab.set(y + offset.get() - box.top);
      pointer.set(y);
    },
    onActivate: (event) => {
      "worklet";
      active.set(pending.get());
      pointer.set(event.absoluteY - top.get());
      scheduleOnRN(setLoopActive, true);
    },
    onUpdate: (event) => {
      "worklet";
      pointer.set(event.absoluteY - top.get());
      insideX.set(withinWidth(horizontal.get(), event.absoluteX));
    },
    onDeactivate: (event) => {
      "worklet";
      const id = active.get();
      const y = event.absoluteY - top.get();
      const inside = withinWidth(horizontal.get(), event.absoluteX) && y >= 0 && y <= height.get();
      const end = dropAt(boxes.get(), rows.get(), id, y + offset.get(), grouped);
      const willPin = inside && y < 48;

      if (!event.canceled && inside && id && (willPin || end.id)) scheduleOnRN(drop, id, end.id, end.before, willPin);
    },
    onFinalize: () => {
      "worklet";
      active.set("");
      pending.set("");
      pin.set(false);
      scheduleOnRN(setLoopActive, false);
    },
  });

  const context = useMemo(
    () => ({ boxes, pickups, rows, active, pointer, grab, offset, height, content, pin, target, move: order.move }),
    [boxes, pickups, rows, active, pointer, grab, offset, height, content, pin, target, order.move],
  );

  return { list, frame, scroll, gesture, context };
}

export type SidebarDrag = ReturnType<typeof useSidebarDrag>["context"];

export const SidebarDragContext = createContext<SidebarDrag | null>(null);
export const useSidebarDragContext = () => useContext(SidebarDragContext);
