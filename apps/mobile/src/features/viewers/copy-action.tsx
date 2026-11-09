import { IconButton } from "../../ui/Button";
import { useCopyText } from "./useCopyText";

export function CopyAction({ text, label }: { text: string; label: string }) {
  const { copied, copy } = useCopyText(text);

  return (
    <IconButton
      icon={copied ? "check" : "clipboard-document"}
      label={copied ? "Copied" : label}
      size="sm"
      onPress={() => void copy()}
    />
  );
}
