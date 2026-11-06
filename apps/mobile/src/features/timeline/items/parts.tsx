import { useState, type ReactNode } from "react";
import { Text, useWindowDimensions, View } from "react-native";
import { prettyJson } from "@canopy/domain/format";
import { font, styles, useColors, useTypography } from "../../../ui/theme";
import { useTone } from "../../../ui/tone";
import { CodeBlock, MoreButton } from "../CodeBlock";

/** A work row's title: what it did (quiet), then what it is about (stronger, truncated); `mono` for paths and commands. */
export function RowTitle({ lead, subject, mono = false }: { lead?: string; subject?: string; mono?: boolean }) {
  const c = useColors();
  const type = useTypography();

  return (
    <Text numberOfLines={1} style={[styles.work, { color: c.soft }]}>
      {lead ? <Text>{lead}</Text> : null}
      {lead && subject ? "  " : null}
      {subject ? (
        <Text style={mono ? [type.mono, { fontSize: 12, color: c.strong }] : { color: c.strong }}>{subject}</Text>
      ) : null}
    </Text>
  );
}

/** Quiet detail on a work row's right: a duration, counts, a state. */
export function Aside({ children, tone }: { children: ReactNode; tone?: "rose" }) {
  const c = useColors();
  const rose = useTone("rose").text;

  return (
    <Text numberOfLines={1} style={[styles.workMeta, { color: tone ? rose : c.muted, fontVariant: ["tabular-nums"] }]}>
      {children}
    </Text>
  );
}

/** "+12 −3" (web: DiffCounts). */
export function DiffCounts({ added, removed }: { added: number; removed: number }) {
  const emerald = useTone("emerald").text;
  const rose = useTone("rose").text;
  const type = useTypography();

  return (
    <Text style={[type.mono, { fontSize: 12, lineHeight: 20 }]}>
      <Text style={{ color: emerald }}>+{added}</Text> <Text style={{ color: rose }}>−{removed}</Text>
    </Text>
  );
}

/** A labelled part of an item's details: "Prompt", "Result", "Input". */
export function Section({ label, children }: { label: string; children: ReactNode }) {
  const c = useColors();

  return (
    <View style={{ gap: 4 }}>
      <Text style={[styles.workMeta, { fontFamily: font.medium, color: c.muted }]}>{label}</Text>
      {children}
    </View>
  );
}

export function EmptyNote({ children }: { children: string }) {
  const c = useColors();

  return <Text style={[styles.workMeta, { color: c.muted, fontStyle: "italic" }]}>{children}</Text>;
}

export function ErrorText({ text }: { text: string }) {
  const rose = useTone("rose").text;

  return (
    <Text selectable accessibilityRole="alert" style={[styles.workMeta, { color: rose }]}>
      {text}
    </Text>
  );
}

/** "Show raw": what a tool really got and returned, for people who need it (web: RawToggle). Closed by default. */
export function RawToggle({ parts }: { parts: readonly { label: string; text: string }[] }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const shown = parts.filter((p) => p.text.trim() !== "");

  if (!shown.length) return null;

  return (
    <View style={{ gap: 8 }}>
      <MoreButton expanded={open} onPress={() => setOpen(!open)}>
        {open ? "Hide raw" : "Show raw"}
      </MoreButton>
      {open &&
        shown.map((part) => (
          <View key={part.label} style={{ gap: 4 }}>
            <Text style={[styles.workMeta, { color: c.muted }]}>{part.label}</Text>
            <CodeBlock text={prettyJson(part.text)} label={part.label} />
          </View>
        ))}
    </View>
  );
}

/** Web `sm` (640 px): quiet details of work rows (a tool's detail, task progress) show only from there on. */
export function useRoomyRows(): boolean {
  return useWindowDimensions().width >= 640;
}
