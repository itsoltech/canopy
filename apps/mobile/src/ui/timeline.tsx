import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ItemStatus, type Item, ui } from "@open-agents/contracts";
import { Markdown } from "./markdown";
import { Icon } from "./Icon";
import { styles, useColors } from "./theme";

function workLabel(item: Item) {
  const content = item.content;
  switch (content.case) {
    case "commandExecution":
      return content.value.command;
    case "toolCall":
      return content.value.name;
    case "reasoning":
      return "Thinking";
    case "fileChange":
      return `${content.value.changes.length} file changes`;
    case "webSearch":
      return `Search: ${content.value.query}`;
    case "backgroundTask":
      return "Background task";
    case "plan":
      return "Plan";
    default:
      return content.case?.replace(/([A-Z])/g, " $1") ?? "Activity";
  }
}
function workDetail(item: Item) {
  const value = item.content.value;
  if (!value) return "";
  if ("output" in value) return String(value.output);
  if ("summary" in value && value.summary) return String(value.summary);
  if ("text" in value) return String(value.text);
  if ("changes" in value) return value.changes.map((c) => c.path).join("\n");
  return "";
}
export function UserMessageView({
  text,
  note,
}: {
  text: string;
  note?: string;
}) {
  const c = useColors();
  return (
    <View style={{ alignItems: "flex-end", gap: 4 }}>
      {note ? (
        <Text style={[styles.meta, { color: c.muted }]}>{note}</Text>
      ) : null}
      <View
        style={{
          maxWidth: "85%",
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderRadius: 16,
          borderBottomRightRadius: 6,
          backgroundColor: c.userBubble,
        }}
      >
        <Text selectable style={[styles.body, { color: c.text }]}>
          {text}
        </Text>
      </View>
    </View>
  );
}
export function WorkGroup({
  items,
  duration,
  working,
}: {
  items: Item[];
  duration: number;
  working: boolean;
}) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const running =
    working || items.some((i) => i.status === ItemStatus.IN_PROGRESS);
  const label = running
    ? "Working…"
    : `Worked for ${duration >= 60 ? `${Math.floor(duration / 60)}m ${duration % 60}s` : `${duration}s`}`;
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={[styles.row, { minHeight: 44, paddingVertical: 10 }]}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} color={c.faint} />
        <Text style={[styles.body, { color: c.muted }]}>{label}</Text>
        {items.length > 0 && (
          <Text style={[styles.meta, { color: c.faint }]}>
            {items.length}{" "}
            {items.every((i) => i.content.case === "commandExecution")
              ? items.length === 1
                ? "command"
                : "commands"
              : items.length === 1
                ? "step"
                : "steps"}
          </Text>
        )}
        <View style={{ flex: 1, height: 1, backgroundColor: c.line }} />
      </Pressable>
      {open && items.map((item) => <ToolRow key={item.itemId} item={item} />)}
    </View>
  );
}
function ToolRow({ item }: { item: Item }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={[
          styles.row,
          {
            minHeight: 44,
            paddingHorizontal: 8,
            backgroundColor: c.inset,
            borderRadius: 8,
          },
        ]}
      >
        <Icon
          name={
            item.content.case === "commandExecution" ? "command-line" : "wrench"
          }
          size={14}
        />
        <Text
          numberOfLines={1}
          style={[
            styles.meta,
            {
              flex: 1,
              color: item.status === ItemStatus.FAILED ? c.danger : c.muted,
            },
          ]}
        >
          {workLabel(item)}
        </Text>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
      </Pressable>
      {open && (
        <Text
          selectable
          style={[
            styles.meta,
            { color: c.muted, fontFamily: "monospace", padding: 12 },
          ]}
        >
          {workDetail(item).slice(0, 12000) || "No additional output."}
        </Text>
      )}
    </View>
  );
}
export function TimelineTurn({
  turn,
  entries,
}: {
  turn: ui.Turn;
  entries: ui.TimelineItem[];
}) {
  const c = useColors();
  const items = entries.flatMap((e) => (e.item ? [e.item] : []));
  const work = items.filter(
    (i) =>
      !["agentMessage", "userMessage", "interactionPrompt"].includes(
        i.content.case ?? "",
      ),
  );
  const message = turn.messageText || turn.inputText;
  const duration = Math.max(
    0,
    Number(
      (turn.completedAt?.seconds ?? turn.startedAt?.seconds ?? 0n) -
        (turn.startedAt?.seconds ?? 0n),
    ),
  );
  return (
    <View style={{ gap: 16, paddingBottom: 28 }}>
      {message ? (
        <UserMessageView
          text={message}
          note={
            turn.status === "queued"
              ? "Queued"
              : turn.sender
                ? `Message from ${turn.sender.title}`
                : turn.trigger === "bot"
                  ? "Message from a bot"
                  : undefined
          }
        />
      ) : null}
      {(work.length > 0 || duration > 0) && (
        <WorkGroup
          items={work}
          duration={duration}
          working={
            turn.status === "running" ||
            items.some((i) => i.status === ItemStatus.IN_PROGRESS)
          }
        />
      )}
      {items.map((item) =>
        item.content.case === "agentMessage" ? (
          <View key={item.itemId} style={{ gap: 8 }}>
            {turn.sourceKind === "report" && (
              <Text style={[styles.meta, { color: c.muted }]}>
                Answer from {turn.sender?.title || "another thread"}
              </Text>
            )}
            <Markdown text={item.content.value.text} />
            {item.status === ItemStatus.IN_PROGRESS && (
              <Text
                accessibilityLiveRegion="polite"
                style={[styles.meta, { color: c.muted }]}
              >
                Working…
              </Text>
            )}
          </View>
        ) : item.content.case === "userMessage" &&
          item.content.value.text !== message ? (
          <UserMessageView key={item.itemId} text={item.content.value.text} />
        ) : null,
      )}
      {turn.error ? (
        <Text
          selectable
          accessibilityRole="alert"
          style={[styles.body, { color: c.danger }]}
        >
          {turn.error}
        </Text>
      ) : null}
      {turn.status === "running" && !items.length ? (
        <Text style={[styles.body, { color: c.muted }]}>Working…</Text>
      ) : null}
    </View>
  );
}
