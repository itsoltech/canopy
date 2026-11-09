import { Text, type TextStyle } from "react-native";
import { MentionKind, type Mention } from "@canopy/contracts";
import type { InlineElements } from "../../ui/markdown";
import { font, useColors } from "../../ui/theme";
import { segmentsOf, type MessageValue } from "./message-value";

export type BadgeTone = "uploading" | "failed" | undefined;

/**
 * A message's text with each mention drawn as a badge in place ("[photo.png]" on a tinted ground). Children of a
 * TextInput (the composer, the queue editor) or of a Text (a sent message): the characters stay the plain text.
 */
export function MessageSpans({ value, tone }: { value: MessageValue; tone?: (mention: Mention) => BadgeTone }) {
  return segmentsOf(value).map((segment, index) =>
    segment.mention ? (
      <MentionBadge key={index} text={segment.text} tone={tone?.(segment.mention)} />
    ) : (
      <Text key={index}>{segment.text}</Text>
    ),
  );
}

/** One mention's placeholder as a badge, inside a line of text. */
export function MentionBadge({
  text,
  tone,
  onPress,
}: {
  text: string;
  tone?: BadgeTone;
  onPress?: (() => void) | undefined;
}) {
  const c = useColors();

  const style: TextStyle = {
    fontFamily: font.medium,
    color: tone === "failed" ? c.danger : tone === "uploading" ? c.muted : c.accent,
    backgroundColor: tone === "failed" ? c.inset : c.softAccent,
  };

  return (
    <Text style={style} onPress={onPress} accessibilityRole={onPress ? "button" : undefined}>
      {text}
    </Text>
  );
}

/** A sent message's mentions as badges inside its markdown (`Markdown` `elements`). */
export function mentionElements(
  text: string,
  mentions: readonly Mention[],
  onAttachment?: (id: string) => void,
): InlineElements | undefined {
  if (mentions.length === 0) return undefined;

  return {
    ranges: mentions,
    render: (index) => {
      const mention = mentions[index];

      return mention ? (
        <MentionBadge
          text={text.slice(mention.start, mention.end)}
          onPress={
            mention.kind === MentionKind.ATTACHMENT && onAttachment ? () => onAttachment(mention.name) : undefined
          }
        />
      ) : null;
    },
  };
}
