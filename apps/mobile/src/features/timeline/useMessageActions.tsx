import { useRef, useState } from "react";
import type { PressableProps } from "react-native";
import { markdownText } from "@canopy/domain/markdown";
import { TextActions } from "../viewers/TextActions";
import { useQuotePassage } from "../quotes/QuoteAction";

/** Message gestures share the kit's sheet; quoting waits until its native modal has dismissed. */
export function useMessageActions(text: string, kind?: string, enabled = true, onEdit?: () => void) {
  const [visible, setVisible] = useState(false);
  const quoteNext = useRef(false);
  const editNext = useRef(false);
  const quote = useQuotePassage(kind ? text : "", kind ?? "");
  const available = enabled && Boolean(text.trim() || onEdit);

  const trigger: PressableProps = available
    ? {
        accessibilityLabel: markdownText(text) || "Message with attachments",
        accessibilityHint: "Long press for message actions",
        accessibilityActions: [{ name: "longpress", label: "Message actions" }],
        onLongPress: () => setVisible(true),
        onAccessibilityAction: ({ nativeEvent }) => {
          if (nativeEvent.actionName === "longpress") setVisible(true);
        },
      }
    : {};

  return {
    trigger,
    available,
    menu: (
      <>
        <TextActions
          text={text}
          visible={available && visible}
          onClose={() => setVisible(false)}
          onEdit={
            onEdit
              ? () => {
                  editNext.current = true;
                }
              : undefined
          }
          onQuote={
            quote.available
              ? () => {
                  quoteNext.current = true;
                }
              : undefined
          }
          onDismiss={() => {
            if (editNext.current) {
              editNext.current = false;
              onEdit?.();

              return;
            }

            if (!quoteNext.current) return;
            quoteNext.current = false;
            quote.open();
          }}
        />
        {quote.editor}
      </>
    ),
  };
}
