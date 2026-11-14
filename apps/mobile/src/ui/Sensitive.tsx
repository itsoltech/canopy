import { useEffect, useRef, useState } from "react";
import { AppState, Text, type StyleProp, type TextStyle } from "react-native";

const REVEAL_MS = 30_000;

/**
 * The hidden form of a value: one bullet per character, spaces kept, so its length reads but nothing else. The real
 * text is never rendered, so screenshots, screen sharing and the accessibility tree cannot read it.
 */
export const maskValue = (value: string) => value.replace(/\S/g, "•");

/**
 * Reveal state shared by every private value (web: Sensitive): a tap toggles it, 30 s, the app leaving the
 * foreground, a new value or unmounting hide it again.
 */
function useReveal(value: string) {
  const [revealed, setRevealed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [shown, setShown] = useState(value);

  const hide = () => {
    clearTimeout(timer.current);
    setRevealed(false);
  };

  if (shown !== value) {
    setShown(value);
    setRevealed(false);
  }

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") hide();
    });

    return () => {
      subscription.remove();
      clearTimeout(timer.current);
    };
  }, []);

  const toggle = () => {
    const next = !revealed;
    hide();

    if (next) {
      setRevealed(true);
      timer.current = setTimeout(hide, REVEAL_MS);
    }
  };

  return { revealed, toggle };
}

/**
 * Screen-sharing privacy for a known personal field (an account email, a proxy host): masked until a tap reveals it.
 * Not encryption; the value is only kept off the screen. Never scans or rewrites arbitrary text.
 */
export function Sensitive({
  value,
  label = "Private value",
  numberOfLines,
  style,
}: {
  value: string;
  label?: string;
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
}) {
  const { revealed, toggle } = useReveal(value);

  return (
    <Text
      accessibilityRole="button"
      accessibilityLabel={revealed ? `${label}: ${value}` : `${label} hidden`}
      accessibilityHint={revealed ? "Double-tap to hide" : "Double-tap to reveal"}
      accessibilityState={{ selected: revealed }}
      selectable={false}
      numberOfLines={numberOfLines}
      onPress={toggle}
      suppressHighlighting
      style={style}
    >
      {revealed ? value : maskValue(value)}
    </Text>
  );
}

const urlParts = (value: string) =>
  value.includes("@") ? null : /^(https?:\/\/)(\[[^\]]+\]|[^/:?#]+)(.*)$/.exec(value);

/** A URL whose host is private (web: SensitiveUrl): the scheme and path stay readable, the host is masked. */
export function SensitiveUrl({
  value,
  numberOfLines,
  style,
}: {
  value: string;
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
}) {
  const { revealed, toggle } = useReveal(value);
  const parts = urlParts(value);
  const label = parts ? "Proxy host" : "Proxy URL";
  const hidden = parts ? `${parts[1]}${maskValue(parts[2] ?? "")}${parts[3] ?? ""}` : maskValue(value);

  return (
    <Text
      accessibilityRole="button"
      accessibilityLabel={revealed ? `${label}: ${value}` : `${label} hidden`}
      accessibilityHint={revealed ? "Double-tap to hide" : "Double-tap to reveal"}
      accessibilityState={{ selected: revealed }}
      selectable={false}
      numberOfLines={numberOfLines}
      onPress={toggle}
      suppressHighlighting
      style={style}
    >
      {revealed ? value : hidden}
    </Text>
  );
}
