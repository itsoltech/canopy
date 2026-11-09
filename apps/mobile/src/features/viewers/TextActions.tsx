import { PickerSheet } from "../../ui/Picker";
import { useCopyText } from "./useCopyText";

export function TextActions({
  text,
  visible,
  onClose,
  onReply,
}: {
  text: string;
  visible: boolean;
  onClose: () => void;
  onReply?: (() => void) | undefined;
}) {
  const { copy } = useCopyText(text);

  return (
    <PickerSheet
      title="Message actions"
      visible={visible}
      onClose={onClose}
      sections={[
        {
          options: [
            ...(onReply ? [{ value: "reply", label: "Reply", icon: "arrow-uturn-left" as const }] : []),
            { value: "copy", label: "Copy message", icon: "clipboard-document" as const },
          ],
        },
      ]}
      onSelect={(action) => {
        if (action === "reply") onReply?.();
        else void copy();
      }}
    />
  );
}
