import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { BlobRef } from "@canopy/contracts";
import { styles, useColors, useTypography } from "../../ui/theme";
import { Chevron } from "../../ui/MotionViews";
import { TextViewerButton } from "../viewers/TextViewerButton";
import { INLINE_PREVIEW } from "../viewers/TextViewer";

/** Code or output on a recessed surface (web: CodeBlock), monospace, selectable, capped for the phone. */
export function CodeBlock({ text, label }: { text: string; label: string }) {
  const c = useColors();
  const type = useTypography();
  const cut = text.length > INLINE_PREVIEW;

  return (
    <View accessibilityLabel={label} style={{ gap: 4 }}>
      <View style={{ borderRadius: 8, backgroundColor: c.well, padding: 12 }}>
        <Text selectable style={[type.mono, { color: c.text }]}>
          {cut ? text.slice(0, INLINE_PREVIEW) : text}
        </Text>
      </View>
      {cut && <TextViewerButton text={text} label={label} />}
    </View>
  );
}

/** A quiet text button that opens or folds more of something (web: MoreButton), with a note beside it. */
export function MoreButton({
  expanded,
  onPress,
  note,
  children,
}: {
  expanded: boolean;
  onPress: () => void;
  note?: string;
  children: string;
}) {
  const c = useColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={onPress}
      hitSlop={8}
      style={[styles.row, { gap: 6, minHeight: 32 }]}
    >
      <Chevron open={expanded} size={14} color={c.faint} />
      <Text style={[styles.workMeta, { color: c.soft }]}>{children}</Text>
      {note ? <Text style={[styles.workMeta, { color: c.muted }]}>{note}</Text> : null}
    </Pressable>
  );
}

/**
 * Output of a command, tool or task (web: OutputBlock); large output lives in a blob on the gateway. With `tail`,
 * long output shows only its last lines (live output of background work) until the reader opens it.
 */
export function OutputBlock({
  output,
  blob,
  label,
  empty = "No output.",
  tail,
}: {
  output: string;
  blob?: BlobRef | undefined;
  label: string;
  empty?: string;
  tail?: number;
}) {
  const c = useColors();
  const [all, setAll] = useState(false);
  const lines = output.replace(/\n$/, "").split("\n");
  const cut = tail !== undefined && lines.length > tail;
  const shown = cut && !all ? lines.slice(-tail).join("\n") : output;

  return (
    <View style={{ gap: 4 }}>
      {output ? (
        <>
          {cut && (
            <MoreButton
              expanded={all}
              onPress={() => setAll(!all)}
              note={all ? `${lines.length} lines` : `Last ${tail} of ${lines.length} lines`}
            >
              {all ? "Show the end only" : "Show all output"}
            </MoreButton>
          )}
          <CodeBlock text={shown} label={label} />
        </>
      ) : null}
      {blob ? (
        <TextViewerButton blob={blob} label={label} />
      ) : !output ? (
        <Text style={[styles.workMeta, { color: c.muted, fontStyle: "italic" }]}>{empty}</Text>
      ) : null}
    </View>
  );
}
