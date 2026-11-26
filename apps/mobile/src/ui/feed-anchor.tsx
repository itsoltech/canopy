import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform, View, type FlatListProps } from "react-native";
import Animated, {
  dispatchCommand,
  measure,
  scrollTo,
  useAnimatedRef,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import type { useFollowingList } from "./useFollowingList";
import { motion, useReducedMotion } from "./motion";
import { disclosureOffset, disclosurePosition } from "./disclosure-anchor";

const nativeMountAnchor = Platform.OS === "ios";

/** One tapped header owns the manual disclosure transition. */
class AnchorSession {
  #version = 0;
  #manual = false;
  #listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  manual = () => this.#manual;

  begin() {
    this.#version++;
    this.#manual = true;
    this.#emit();

    return this.#version;
  }

  end(version: number) {
    if (!this.#manual || version !== this.#version) return;
    this.#manual = false;
    this.#emit();
  }

  #emit() {
    for (const listener of this.#listeners) listener();
  }
}

export function useFeedAnchor<Item>({
  list,
  scrollY,
  minimum,
  corrections,
  anchoring,
  track,
}: ReturnType<typeof useFollowingList<Item>>) {
  const generation = useSharedValue(0);
  const [session] = useState(() => new AnchorSession());

  const geometry = useMemo(
    () => ({
      scrollY,
      minimum,
      corrections,
      anchoring,
      generation,
      track,
      setNativeHeader: (tag: number) => {
        "worklet";

        if (nativeMountAnchor) dispatchCommand(list, "setCanopyDisclosureHeader", [tag]);
      },
      scrollToOffset: (offset: number) => {
        "worklet";
        scrollTo(list, 0, offset, false);
      },
    }),
    [list, scrollY, minimum, corrections, anchoring, generation, track],
  );

  return useMemo(() => ({ session, geometry }), [session, geometry]);
}

const Anchor = createContext<ReturnType<typeof useFeedAnchor> | null>(null);
const idle = new AnchorSession();
const Cell = createContext<ReturnType<typeof useAnimatedRef<View>> | null>(null);

/** Preserve FlatList's inversion style and layout notifications; expose its actual cell geometry. */
export function FeedAnchorCell<Item>({
  children,
  style,
  onLayout,
  onFocusCapture,
}: React.ComponentProps<NonNullable<FlatListProps<Item>["CellRendererComponent"]>>) {
  const cell = useAnimatedRef<View>();

  return (
    <Cell.Provider value={cell}>
      <Animated.View ref={cell} collapsable={false} style={style} onLayout={onLayout} onFocusCapture={onFocusCapture}>
        {children}
      </Animated.View>
    </Cell.Provider>
  );
}

/** Both page measurements contain the same scroll checkpoint, which cancels in their difference. */
function correctHeader(
  geometry: ReturnType<typeof useFeedAnchor>["geometry"],
  origin: SharedValue<{ offset: number; position: number }>,
  after: number,
) {
  "worklet";
  const start = origin.get();
  const next = disclosureOffset(start.offset, start.position, after, geometry.minimum.get());
  const delta = next - geometry.scrollY.get();

  if (Math.abs(delta) < 0.5) return true;
  // Native layout can clamp a request while newly expanded rows mount. Only onScroll knows the applied offset.
  geometry.corrections.set(geometry.corrections.get() + 1);
  geometry.scrollToOffset(next);

  return false;
}

export function FeedAnchorProvider({
  value,
  children,
}: {
  value: ReturnType<typeof useFeedAnchor>;
  children: ReactNode;
}) {
  return <Anchor.Provider value={value}>{children}</Anchor.Provider>;
}

/** Only the list wrapper subscribes; starting a toggle does not replace turn props or the data array. */
export function useManualFeedAnchor() {
  const session = useContext(Anchor)?.session ?? idle;

  return useSyncExternalStore(session.subscribe, session.manual);
}

/**
 * iOS holds the tapped header during Fabric's mount transaction. Android corrects from UI geometry.
 * Only the tapped header checks for completion. A drag or a different header supersedes the session.
 */
export function useAnchoredToggle() {
  const anchor = useContext(Anchor);
  const cell = useContext(Cell);
  const header = useAnimatedRef<View>();
  const reduced = useReducedMotion();
  const origin = useSharedValue({ offset: 0, position: 0 });
  const native = useSharedValue(false);
  const lastPosition = useSharedValue(0);
  const started = useSharedValue(0);
  const version = useSharedValue(0);
  const stable = useSharedValue(0);
  const active = useSharedValue(false);
  // Keep class instances and JS listeners out of the worklet closure.
  const geometry = anchor?.geometry;

  const finish = (id: number) => {
    if (version.get() === id) frames.setActive(false);
    anchor?.session.end(id);

    if (!geometry) return;
    scheduleOnUI(() => {
      if (geometry.generation.get() !== id) return;

      if (native.get()) geometry.setNativeHeader(0);
      geometry.anchoring.set(false);
      geometry.track(geometry.scrollY.get(), true);
    });
  };

  const frames = useFrameCallback(() => {
    "worklet";

    if (!geometry || !cell || !active.get()) return;
    const box = measure(header);
    const frame = measure(cell);

    if (!geometry.anchoring.get() || geometry.generation.get() !== version.get() || !box || !frame || box.height <= 0) {
      active.set(false);
      scheduleOnRN(finish, version.get());

      return;
    }

    const position = disclosurePosition(frame.y, frame.height, frame.pageY, box.pageY);

    const steady = native.get()
      ? Math.abs(position - lastPosition.get()) < 0.5
      : correctHeader(geometry, origin, position);

    lastPosition.set(position);
    stable.set(steady ? stable.get() + 1 : 0);

    const elapsed = Date.now() - started.get();
    // Give the first lazy body mount time to begin before two unchanged frames can finish the hold.
    const settleAfter = (reduced ? 0 : motion.fast) + (native.get() ? motion.quick : 0);

    if ((elapsed >= settleAfter && stable.get() >= 2) || elapsed >= motion.fast + motion.slow) {
      active.set(false);
      scheduleOnRN(finish, version.get());
    }
  }, false);

  useEffect(
    () => () => {
      frames.setActive(false);
      anchor?.session.end(version.get());

      if (!geometry) return;
      scheduleOnUI(() => {
        if (geometry.generation.get() !== version.get()) return;

        if (native.get()) geometry.setNativeHeader(0);
        geometry.anchoring.set(false);
      });
    },
    [frames, anchor, version, geometry, native],
  );

  return {
    header,
    toggle(change: () => void) {
      if (!anchor || !geometry || !cell) return change();
      const id = anchor.session.begin();
      const tag = nativeMountAnchor ? (header.getTag?.() ?? 0) : 0;
      frames.setActive(true);
      scheduleOnUI(() => {
        const box = measure(header);
        const frame = measure(cell);
        const reversal = active.get() && geometry.anchoring.get() && geometry.generation.get() === version.get();
        version.set(id);
        geometry.generation.set(id);
        stable.set(0);
        started.set(Date.now());
        active.set(Boolean(box && frame && box.height > 0));
        native.set(active.get() && tag > 0);
        geometry.anchoring.set(active.get());

        geometry.setNativeHeader(native.get() ? tag : 0);

        if (box && frame) {
          const position = disclosurePosition(frame.y, frame.height, frame.pageY, box.pageY);
          lastPosition.set(position);

          if (!reversal) origin.set({ offset: geometry.scrollY.get(), position });
        }

        scheduleOnRN(change);

        if (!active.get()) scheduleOnRN(finish, id);
      });
    },
  };
}
