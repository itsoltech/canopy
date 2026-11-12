import { Text, type TextStyle } from "react-native";
import { MentionKind, type Mention, type ui } from "@canopy/contracts";
import { citationLabel } from "@canopy/domain";
import type { InlineElements } from "../../ui/markdown";
import { font, useColors } from "../../ui/theme";
import { segmentsOf, type MessageValue } from "./message-value";
import { InlineCitation } from "../quotes/InlineCitation";

export type BadgeTone = "uploading" | "failed" | undefined;

/**
 * A message's text with each mention drawn as a badge in place ("[photo.png]" on a tinted ground). Children of a
 * TextInput (the composer, the queue editor) or of a Text (a sent message): the characters stay the plain text.
 */
export function MessageSpans({
  value,
  tone,
  onQuote,
}: {
  value: MessageValue;
  tone?: (mention: Mention) => BadgeTone;
  onQuote?: (quote: ui.Quote) => void;
}) {
  return segmentsOf(value).map((segment, index) =>
    segment.quote ? (
      onQuote ? (
        <MentionBadge
          key={index}
          text={segment.text}
          label={`Citation: ${citationLabel(segment.quote.text)}`}
          onPress={() => onQuote(segment.quote!)}
        />
      ) : (
        <InlineCitation key={index} quote={segment.quote} />
      )
    ) : segment.mention ? (
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
  label,
}: {
  text: string;
  tone?: BadgeTone;
  onPress?: (() => void) | undefined;
  label?: string;
}) {
  const c = useColors();

  const style: TextStyle = {
    fontFamily: font.medium,
    color: tone === "failed" ? c.danger : tone === "uploading" ? c.muted : c.accent,
    backgroundColor: tone === "failed" ? c.inset : c.softAccent,
  };

  return (
    <Text style={style} onPress={onPress} accessibilityLabel={label} accessibilityRole={onPress ? "button" : undefined}>
      {text}
    </Text>
  );
}

/** A sent message's mentions as badges inside its markdown (`Markdown` `elements`). */
export function mentionElements(
  text: string,
  mentions: readonly Mention[],
  onAttachment?: (id: string) => void,
  quotes: readonly ui.Quote[] = [],
): InlineElements | undefined {
  const ranges = [
    ...mentions.map((mention) => ({ start: mention.start, end: mention.end, mention, quote: undefined })),
    ...quotes.flatMap((quote) =>
      quote.start !== undefined && quote.end !== undefined
        ? [{ start: quote.start, end: quote.end, quote, mention: undefined }]
        : [],
    ),
  ].sort((a, b) => a.start - b.start);

  if (ranges.length === 0) return undefined;

  return {
    ranges,
    render: (index) => {
      const element = ranges[index];

      if (element?.quote) return <InlineCitation quote={element.quote} />;
      const mention = element?.mention;

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
