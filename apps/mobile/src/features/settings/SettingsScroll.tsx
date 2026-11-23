import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ComponentRef,
} from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView, View } from "react-native";
import { useContentInsets } from "../../ui/ScreenFrame";
import { ScreenScroll } from "../../ui/ScreenScroll";

/** Offsets belong to the open Settings window, including its section picker on phones. */
export const SettingsOffsets = createContext<Map<string, number> | null>(null);
const Position = createContext("");

/** Keep filters and inline disclosures with their panel's scroll position for this Settings window. */
export function createSettingsViewState<T>(initial: T) {
  const values = new WeakMap<Map<string, number>, Map<string, { value: T }>>();

  // Omit itemKey for panel state. A null key keeps a caller's state local to its mount.
  return function useSettingsViewState(itemKey?: string | null, initialValue: T = initial) {
    const offsets = useContext(SettingsOffsets);
    const position = useContext(Position);
    const session = itemKey === null ? null : offsets;
    const key = itemKey == null ? position : JSON.stringify([position, itemKey]);
    const [source, setSource] = useState({ session, key });

    function read() {
      const saved = session && values.get(session)?.get(key);

      return saved ? saved.value : initialValue;
    }

    const [value, setValue] = useState<T>(read);

    // A row may stay mounted when the owner selects another computer or changes a scope.
    if (source.session !== session || source.key !== key) {
      setSource({ session, key });
      setValue(read);
    }

    useLayoutEffect(() => {
      if (!session) return;
      const panel = values.get(session) ?? new Map<string, { value: T }>();
      panel.set(key, { value });
      values.set(session, panel);
    }, [session, key, value]);

    return [value, setValue] as const;
  };
}

const RevealView = createContext<(target: ComponentRef<typeof View> | null) => void>(() => {});
export const useRevealSettingsView = () => useContext(RevealView);

export function useSettingsScrollPosition(id: string, scrollTo: (offset: number) => void) {
  const offsets = useContext(SettingsOffsets);
  const [initial] = useState(() => ({ x: 0, y: offsets?.get(id) ?? 0 }));
  const pending = useRef(initial.y);
  const frame = useRef(0);
  const content = useRef(0);

  // Native scroll views clamp their initial offsets while asynchronous sections and list windows lay out.
  function restore() {
    if (pending.current && frame.current && content.current) {
      scrollTo(Math.max(0, Math.min(pending.current, content.current - frame.current)));
    }
  }

  return {
    contentOffset: initial,
    scrollEventThrottle: 16,
    onLayout(event: LayoutChangeEvent) {
      frame.current = event.nativeEvent.layout.height;
      restore();
    },
    onContentSizeChange(_width: number, height: number) {
      content.current = height;
      restore();
    },
    onTouchStart() {
      pending.current = 0;
    },
    onScroll({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) {
      const y = Math.max(0, nativeEvent.contentOffset.y);

      if (pending.current && Math.abs(y - pending.current) > 1) return;
      pending.current = 0;
      offsets?.set(id, y);
    },
  };
}

export function SettingsScroll({
  position,
  children,
  ...props
}: ComponentProps<typeof ScreenScroll> & { position: string }) {
  const view = useRef<ComponentRef<typeof ScrollView>>(null);
  const inner = useRef<ComponentRef<typeof View>>(null);
  const memory = useSettingsScrollPosition(position, (y) => view.current?.scrollTo({ y, animated: false }));

  const insets = useContentInsets();

  function reveal(target: ComponentRef<typeof View> | null) {
    const content = inner.current;

    if (target && content)
      target.measureLayout(content, (_x, y) => {
        memory.onTouchStart();
        view.current?.scrollTo({ y: Math.max(0, y - insets.top - (props.space ?? 16)), animated: false });
      });
  }

  return (
    <ScreenScroll scrollViewRef={view} innerViewRef={inner} {...memory} {...props}>
      <Position.Provider value={position}>
        <RevealView.Provider value={reveal}>{children}</RevealView.Provider>
      </Position.Provider>
    </ScreenScroll>
  );
}
