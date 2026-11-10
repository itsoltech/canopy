import { IconButton } from "../../ui/Button";
import { useCopyText } from "./useCopyText";
import type { StyleProp, ViewStyle } from "react-native";

export function CopyAction({ text, label, style }: { text: string; label: string; style?: StyleProp<ViewStyle> }) {
  const { copied, copy } = useCopyText(text);

  return (
    <IconButton
      icon={copied ? "check" : "clipboard-document"}
      label={copied ? "Copied" : label}
      size="sm"
      style={style}
      onPress={() => void copy()}
    />
  );
}
