import { createContext, useContext, useEffect, useRef, type ReactNode, type ComponentRef } from "react";
import { View } from "react-native";
import { useVisibility } from "./viewport";

export interface ScrollItem {
  readonly node: ComponentRef<typeof View>;
  readonly parent: string;
}

export const ThreadScrollItems = createContext<Map<string, ScrollItem> | undefined>(undefined);
export const ThreadScrollParent = createContext("");
export const ThreadScrollTarget = createContext<string | undefined>(undefined);

/** The row being restored, relative to this turn. Only seeds the initial disclosure choices. */
export function useThreadScrollTarget() {
  const target = useContext(ThreadScrollTarget);
  const parent = useContext(ThreadScrollParent);

  return target?.startsWith(`${parent}/`) ? target.slice(parent.length + 1) : undefined;
}

/** Real message geometry, independent of the height of the work/folds preceding it in its turn. */
export function ThreadScrollItem({ id, children }: { id: string; children: ReactNode }) {
  const items = useContext(ThreadScrollItems);
  const visible = useVisibility();
  const parent = useContext(ThreadScrollParent);
  const node = useRef<ComponentRef<typeof View>>(null);
  const key = `${parent}/${id}`;

  useEffect(() => {
    if (!visible || !items || !node.current) return;
    const item = { node: node.current, parent };
    items.set(key, item);

    return () => {
      if (items.get(key) === item) items.delete(key);
    };
  }, [items, key, parent, visible]);

  return (
    <View ref={node} collapsable={false}>
      {children}
    </View>
  );
}
