import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMotion } from "./motion";
import { styles, useColors } from "./theme";

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => Promise<void> };
}

let sequence = 0;
let current: readonly Toast[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly Toast[]) {
  current = next;

  for (const listener of listeners) listener();
}

export function toast(text: string, action?: Toast["action"]) {
  const entry = { id: ++sequence, text, action };
  publish([...current, entry]);
  setTimeout(() => publish(current.filter((item) => item.id !== entry.id)), 8000);
}

export function ToastHost() {
  const insets = useSafeAreaInsets();

  const entries = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    () => current,
  );

  useEffect(() => () => publish([]), []);

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: insets.left + 16,
        right: insets.right + 16,
        bottom: insets.bottom + 12,
        alignItems: "center",
        gap: 8,
      }}
    >
      {entries.map((entry) => (
        <ToastRow key={entry.id} entry={entry} />
      ))}
    </View>
  );
}

function ToastRow({ entry }: { entry: Toast }) {
  const c = useColors();
  const { toast: motion } = useMotion();
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!entry.action || busy) return;
    setBusy(true);

    try {
      await entry.action.run();
    } catch {
      toast("Could not undo this change. Check the connection and retry.", entry.action);
    } finally {
      publish(current.filter((item) => item.id !== entry.id));
    }
  }

  return (
    <Animated.View
      entering={motion.entering}
      exiting={motion.exiting}
      style={[
        styles.row,
        {
          maxWidth: 480,
          paddingLeft: 16,
          paddingRight: 8,
          paddingVertical: 6,
          borderRadius: 16,
          backgroundColor: c.dark ? c.inset : c.text,
        },
      ]}
    >
      <Text
        accessibilityLiveRegion="polite"
        style={[styles.meta, { flexShrink: 1, color: c.dark ? c.text : c.surface }]}
      >
        {entry.text}
      </Text>
      {entry.action && (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          accessibilityState={{ disabled: busy, busy }}
          onPress={() => void run()}
          style={{ minHeight: 44, paddingHorizontal: 8, justifyContent: "center" }}
        >
          <Text style={[styles.meta, { color: c.brandOnInk }]}>{entry.action.label}</Text>
        </Pressable>
      )}
    </Animated.View>
  );
}
