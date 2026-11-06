import { createContext, useContext, useMemo, type ReactNode, type RefObject } from "react";
import type { HostInstance } from "react-native";

/**
 * Keeps what the reader tapped where it was (docs/timeline-folding.md): opening or closing a fold grows or shrinks
 * the content under its header; the header itself and everything above it stay on screen. The feed is an inverted
 * FlatList, where a row grows towards older content, so the header would move; the anchor measures it before the
 * change and moves the list by as much as it moved. A reader following the bottom stays there when the fold is in
 * the latest turn.
 */
export interface FeedAnchor {
  /** Runs `change` (a toggle) with `target` (the tapped header) held in place; `latest`: it is in the latest turn. */
  readonly toggle: (target: HostInstance | null, change: () => void, latest: boolean) => void;
}

const Anchor = createContext<FeedAnchor>({ toggle: (_target, change) => change() });

/** Whether rows under this provider belong to the latest turn (the bottom of the feed). */
const Latest = createContext(false);

export function LatestScope({ latest, children }: { latest: boolean; children: ReactNode }) {
  return <Latest.Provider value={latest}>{children}</Latest.Provider>;
}

export function FeedAnchorProvider({ value, children }: { value: FeedAnchor; children: ReactNode }) {
  return <Anchor.Provider value={value}>{children}</Anchor.Provider>;
}

/** A toggle that keeps its header (`target`) in place. */
export function useAnchoredToggle() {
  const anchor = useContext(Anchor);
  const latest = useContext(Latest);

  return (target: HostInstance | null, change: () => void) => anchor.toggle(target, change, latest);
}

interface Scrollable {
  scrollToOffset(params: { offset: number; animated?: boolean }): void;
}

/**
 * The anchor of an inverted list: `offset` is its current scroll offset (kept by its scroll events), `following`
 * whether the reader is at the bottom. Rows in the latest turn bypass the anchor only while the reader follows.
 */
export function useFeedAnchor(
  list: RefObject<Scrollable | null>,
  offset: RefObject<number>,
  following: () => boolean,
): FeedAnchor {
  return useMemo(
    () => ({
      toggle(target, change, latest) {
        // Following the bottom, a fold in the latest turn keeps the reader at the bottom: the list does that itself.
        if (!target || (latest && following())) return change();

        target.measureInWindow((_x, before) => {
          change();

          // Layout lands within a frame or two; a late one (fonts, images, markdown) is caught by the second check.
          const settle = () =>
            target.measureInWindow((_x2, after) => {
              const moved = after - before;

              if (Math.abs(moved) < 1) return;
              // Inverted: a larger offset shows older content, which moves the rows down the screen.
              offset.current = Math.max(0, offset.current - moved);
              list.current?.scrollToOffset({ offset: offset.current, animated: false });
            });

          requestAnimationFrame(() => requestAnimationFrame(settle));
          setTimeout(settle, 180);
        });
      },
    }),
    [list, offset, following],
  );
}
