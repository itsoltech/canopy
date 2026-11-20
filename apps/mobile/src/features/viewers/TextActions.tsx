import { PickerSheet } from "../../ui/Picker";
import { useCopyText } from "./useCopyText";

export function TextActions({
  text,
  visible,
  onClose,
  onReply,
  onQuote,
  onDismiss,
  onEdit,
  onSelectText,
}: {
  text: string;
  visible: boolean;
  onClose: () => void;
  onReply?: (() => void) | undefined;
  onQuote?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
  onEdit?: (() => void) | undefined;
  onSelectText?: (() => void) | undefined;
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
            ...(onEdit ? [{ value: "edit", label: "Edit from here", icon: "arrow-uturn-left" as const }] : []),
            ...(onReply ? [{ value: "reply", label: "Reply", icon: "arrow-uturn-left" as const }] : []),
            { value: "copy", label: "Copy message", icon: "clipboard-document" as const },
            ...(onSelectText ? [{ value: "select", label: "Select text", icon: "document-text" as const }] : []),
            ...(onQuote ? [{ value: "quote", label: "Quote passage", icon: "chat-bubble-left-right" as const }] : []),
          ],
        },
      ]}
      onSelect={(action) => {
        if (action === "edit") onEdit?.();
        else if (action === "reply") onReply?.();
        else if (action === "quote") onQuote?.();
        else if (action === "select") onSelectText?.();
        else void copy();
      }}
    />
  );
}
