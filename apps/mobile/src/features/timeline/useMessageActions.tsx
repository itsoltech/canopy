import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { TurboModuleRegistry, type PressableProps } from "react-native";
import { markdownText } from "@canopy/domain/markdown";
import { TextActions } from "../viewers/TextActions";
import { useQuotePassage } from "../quotes/QuoteAction";

const canSelect = TurboModuleRegistry.get("RNCWebViewModule") !== null;

const PassageSelection = lazy(() =>
  import("../quotes/PassageSelection").then((m) => ({ default: m.PassageSelection })),
);

/** Keep the passage stable as more text streams in. Open the next sheet after the menu has dismissed. */
export function useMessageActions(text: string, kind?: string, enabled = true, onEdit?: () => void) {
  const [menuText, setMenuText] = useState<string>();
  const [selecting, setSelecting] = useState<string>();
  const afterDismiss = useRef<() => void>(undefined);
  const passage = menuText ?? text;
  const quote = useQuotePassage(kind ? passage : "", kind ?? "");
  const available = enabled && Boolean(text.trim() || onEdit);
  const plain = useMemo(() => (available ? markdownText(passage) : ""), [available, passage]);

  function openMenu() {
    setMenuText(text);
  }

  function defer(action: () => void) {
    afterDismiss.current = action;
  }

  const trigger: PressableProps = available
    ? {
        accessibilityLabel: plain || "Message with attachments",
        accessibilityHint: "Long press for message actions",
        accessibilityActions: [{ name: "longpress", label: "Message actions" }],
        onLongPress: openMenu,
        onAccessibilityAction: ({ nativeEvent }) => {
          if (nativeEvent.actionName === "longpress") openMenu();
        },
      }
    : {};

  return {
    trigger,
    available,
    menu: (
      <>
        <TextActions
          text={menuText ?? ""}
          visible={menuText !== undefined}
          onClose={() => setMenuText(undefined)}
          onEdit={onEdit && (() => defer(onEdit))}
          onQuote={quote.available ? () => defer(quote.open) : undefined}
          onSelectText={kind && canSelect && plain ? () => defer(() => setSelecting(plain)) : undefined}
          onDismiss={() => {
            const next = afterDismiss.current;
            afterDismiss.current = undefined;
            next?.();
          }}
        />
        {selecting !== undefined && (
          <Suspense fallback={null}>
            <PassageSelection text={selecting} onQuote={quote.addSelection} onClose={() => setSelecting(undefined)} />
          </Suspense>
        )}
        {quote.editor}
      </>
    ),
  };
}
