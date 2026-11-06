import { Text, type TextStyle } from "react-native";
import type { Mention } from "@canopy/contracts";
import { font, useColors } from "../../ui/theme";
import { segmentsOf, type MessageValue } from "./message-value";

export type BadgeTone = "uploading" | "failed" | undefined;

/**
 * A message's text with each mention drawn as a badge in place ("[photo.png]" on a tinted ground). Children of a
 * TextInput (the composer, the queue editor) or of a Text (a sent message): the characters stay the plain text.
 */
export function MessageSpans({ value, tone }: { value: MessageValue; tone?: (mention: Mention) => BadgeTone }) {
  const c = useColors();

  return segmentsOf(value).map((segment, index) => {
    if (!segment.mention) return <Text key={index}>{segment.text}</Text>;
    const state = tone?.(segment.mention);

    const style: TextStyle = {
      fontFamily: font.medium,
      color: state === "failed" ? c.danger : state === "uploading" ? c.muted : c.accent,
      backgroundColor: state === "failed" ? c.inset : c.softAccent,
    };

    return (
      <Text key={index} style={style}>
        {segment.text}
      </Text>
    );
  });
}
