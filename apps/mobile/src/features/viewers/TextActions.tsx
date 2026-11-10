import { PickerSheet } from "../../ui/Picker";
import { useCopyText } from "./useCopyText";

export function TextActions({
  text,
  visible,
  onClose,
  onReply,
  onQuote,
  onDismiss,
}: {
  text: string;
  visible: boolean;
  onClose: () => void;
  onReply?: (() => void) | undefined;
  onQuote?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
}) {
  const { copy } = useCopyText(text);

  return (
    <PickerSheet
      title="Message actions"
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      sections={[
        {
          options: [
            ...(onReply ? [{ value: "reply", label: "Reply", icon: "arrow-uturn-left" as const }] : []),
            { value: "copy", label: "Copy message", icon: "clipboard-document" as const },
            ...(onQuote ? [{ value: "quote", label: "Quote passage", icon: "chat-bubble-left-right" as const }] : []),
          ],
        },
      ]}
      onSelect={(action) => {
        if (action === "reply") onReply?.();
        else if (action === "quote") onQuote?.();
        else void copy();
      }}
    />
  );
}
