import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ItemStatus, MentionKind, type Item, type Mention, ui } from "@canopy/contracts";
import { turnProgress, workFoldOpen, workSegments } from "@canopy/domain/work-fold";
import { useDevicePreferences } from "../state/preferences";
import { Markdown } from "./markdown";
import { Icon } from "./Icon";
import { styles, useColors } from "./theme";
import { ShellMessage } from "./ShellMessage";
import { MessageSpans } from "../features/composer/MessageText";

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
  attachments = [],
  mentions = [],
  onActions,
}: {
  text: string;
  note?: string;
  /** A queued message's "…": edit or delete it. */
  onActions?: () => void;
  attachments?: ui.Attachment[];
  /** Badges in the text (files placed there, other mentions); files not placed stay as chips above it. */
  mentions?: readonly Mention[];
}) {
  const c = useColors();
  const placed = new Set(mentions.flatMap((m) => (m.kind === MentionKind.ATTACHMENT ? [m.name] : [])));
  const loose = attachments.filter((a) => !placed.has(a.id));

  return (
    <View style={{ alignItems: "flex-end", gap: 4 }}>
      {note || onActions ? (
        <View style={[styles.row, { gap: 2 }]}>
          {note ? <Text style={[styles.meta, { color: c.muted }]}>{note}</Text> : null}
          {onActions ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Queued message actions"
              onPress={onActions}
              hitSlop={8}
              style={({ pressed }) => ({
                width: 32,
                height: 32,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 8,
                backgroundColor: pressed ? c.inset : "transparent",
              })}
            >
              <Icon name="ellipsis-horizontal" size={16} color={c.muted} />
            </Pressable>
          ) : null}
        </View>
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
        {loose.length > 0 && (
          <View style={[styles.row, { flexWrap: "wrap", gap: 4, marginBottom: text ? 6 : 0 }]}>
            {loose.map((a) => (
              <View
                key={a.id}
                accessibilityLabel={`Attached ${a.name}`}
                style={[styles.row, { gap: 4, paddingHorizontal: 6, borderRadius: 6, backgroundColor: c.inset }]}
              >
                <Icon name={a.kind === "image" ? "photo" : "document-text"} size={12} />
                <Text numberOfLines={1} style={[styles.caption, { color: c.body, maxWidth: 180 }]}>
                  {a.name}
                </Text>
              </View>
            ))}
          </View>
        )}
        {text ? (
          <Text selectable style={[styles.body, { color: c.text }]}>
            {mentions.length ? <MessageSpans value={{ text, mentions }} /> : text}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** The turn's tool work counted in the header, and everything the open fold shows, in order. */
/** Messages and reasoning with no text yet add nothing to the turn. */
const isEmpty = (item: Item) =>
  (item.content.case === "agentMessage" && !item.content.value.text.trim()) ||
  (item.content.case === "reasoning" && !item.content.value.text.trim() && !item.content.value.summary.trim());

/** The turn's own input, shown above the fold; other user messages are steers inside it. */
const isInput = (item: Item, message: string) =>
  item.content.case === "userMessage" && item.content.value.text === message;

export function WorkGroup({
  items,
  rows,
  duration,
  running,
  open,
  onToggle,
}: {
  items: Item[];
  rows: Item[];
  /** Seconds; undefined when a segment's bounds are unknown (an older gateway's snapshot). */
  duration: number | undefined;
  running: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const c = useColors();

  const label = running
    ? "Working…"
    : duration === undefined
      ? "Work"
      : `Worked for ${duration >= 60 ? `${Math.floor(duration / 60)}m ${duration % 60}s` : `${duration}s`}`;

  return (
    <View style={{ gap: 2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={[styles.row, { minHeight: 44, paddingVertical: 10 }]}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} color={c.faint} />
        <Text style={[styles.work, { color: c.muted }]}>{label}</Text>
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
      {open &&
        rows.map((item) =>
          item.content.case === "agentMessage" ? (
            <View key={item.itemId} style={{ paddingVertical: 8 }}>
              <Markdown text={item.content.value.text} />
            </View>
          ) : item.content.case === "userMessage" ? (
            <UserMessageView key={item.itemId} text={item.content.value.text} />
          ) : (
            <ToolRow key={item.itemId} item={item} />
          ),
        )}
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
            minHeight: 40,
            paddingHorizontal: 8,
            backgroundColor: open ? c.inset : "transparent",
            borderRadius: 8,
          },
        ]}
      >
        <Icon name={item.content.case === "commandExecution" ? "command-line" : "wrench"} size={14} />
        <Text
          numberOfLines={1}
          style={[
            styles.workMeta,
            {
              flex: 1,
              color: item.status === ItemStatus.FAILED ? c.danger : c.muted,
              fontFamily: item.content.case === "commandExecution" ? "monospace" : styles.workMeta.fontFamily,
            },
          ]}
        >
          {workLabel(item)}
        </Text>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
      </Pressable>
      {open && (
        <Text selectable style={[styles.meta, { color: c.muted, fontFamily: "monospace", padding: 12 }]}>
          {workDetail(item).slice(0, 12000) || "No additional output."}
        </Text>
      )}
    </View>
  );
}

export function TimelineTurn({
  turn,
  entries,
  onQueued,
}: {
  turn: ui.Turn;
  entries: ui.TimelineItem[];
  /** Actions of this thread's own queued message that has not started. */
  onQueued?: (turn: ui.Turn) => void;
}) {
  const c = useColors();
  const { workFold } = useDevicePreferences();
  // Settings → Threads → Turn activity decides until the reader taps; the tap wins for the rest of the visit (per segment).
  const [choices, setChoices] = useState<ReadonlyMap<number, boolean>>(new Map());
  const items = entries.flatMap((e) => (e.item ? [e.item] : []));
  const message = turn.messageText || turn.inputText;
  const working = turn.status === "running" || items.some((i) => i.status === ItemStatus.IN_PROGRESS);

  // Work, steers and messages in order; only a confirmed answer shows outside a fold, and work after a shown
  // answer starts the next segment (docs/timeline-folding.md).
  const body = entries.filter(
    (e): e is ui.TimelineItem & { item: Item } =>
      !!e.item && e.item.content.case !== "interactionPrompt" && !isEmpty(e.item) && !isInput(e.item, message),
  );

  const rows = body.map(({ item }) => ({
    phase: item.content.case === "agentMessage" && !item.parentItemId ? item.content.value.phase : undefined,
    steer: item.content.case === "userMessage",
  }));

  const progress = turnProgress(turn.status);
  const plan = workSegments(rows, progress, () => false);

  const open = (index: number) =>
    workFoldOpen(index === plan.length - 1 && working, plan[index]?.answered ?? false, workFold, choices.get(index));

  const segments = workSegments(rows, progress, open);
  const seconds = (time: ui.Turn["startedAt"]) => (time ? Number(time.seconds) : undefined);

  if (turn.shellCommand !== undefined)
    return (
      <View style={{ paddingBottom: 28 }}>
        <ShellMessage command={turn.shellCommand} result={turn.shellResult} status={turn.status} error={turn.error} />
      </View>
    );

  return (
    <View style={{ gap: 16, paddingBottom: 28 }}>
      {message || turn.attachments.length ? (
        <UserMessageView
          text={message}
          attachments={turn.attachments}
          mentions={turn.messageText ? turn.mentions : []}
          onActions={
            onQueued && turn.status === "queued" && !turn.dispatched && !turn.fromThreadId
              ? () => onQueued(turn)
              : undefined
          }
          note={
            turn.status === "queued"
              ? turn.dispatched
                ? "Starting"
                : "Queued"
              : turn.sender
                ? `Message from ${turn.sender.title}`
                : turn.trigger === "bot"
                  ? "Message from a bot"
                  : undefined
          }
        />
      ) : null}
      {segments.map((segment, index) => {
        const answer = body[segment.answer]?.item;
        const start = index ? seconds(body[segments[index - 1]!.answer]?.completedAt) : seconds(turn.startedAt);

        const end =
          index < segments.length - 1 ? seconds(body[segment.answer]?.completedAt) : seconds(turn.completedAt);

        const duration = start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined;
        const inputs = body.slice(segment.start, segment.start + segment.inputs).map((e) => e.item);

        const work = body
          .slice(segment.start + segment.inputs, segment.end)
          .flatMap((e) => (e.item === answer ? [] : [e.item]));

        return (
          <View key={index} style={{ gap: 16 }}>
            {inputs.map((item) =>
              item.content.case === "userMessage" ? (
                <UserMessageView key={item.itemId} text={item.content.value.text} />
              ) : null,
            )}
            {(work.length > 0 || !!duration || index > 0) && (
              <WorkGroup
                items={work.filter((i) => !["agentMessage", "userMessage"].includes(i.content.case ?? ""))}
                rows={work}
                duration={duration}
                running={index === segments.length - 1 && working}
                open={open(index)}
                onToggle={() => setChoices(new Map(choices).set(index, !open(index)))}
              />
            )}
            {answer?.content.case === "agentMessage" && (
              <View style={{ gap: 8 }}>
                {turn.sourceKind === "report" && (
                  <Text style={[styles.meta, { color: c.muted }]}>
                    Answer from {turn.sender?.title || "another thread"}
                  </Text>
                )}
                <Markdown text={answer.content.value.text} />
                {answer.status === ItemStatus.IN_PROGRESS && (
                  <Text accessibilityLiveRegion="polite" style={[styles.meta, { color: c.muted }]}>
                    Working…
                  </Text>
                )}
              </View>
            )}
          </View>
        );
      })}
      {turn.error ? (
        <Text selectable accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>
          {turn.error}
        </Text>
      ) : null}
      {turn.status === "running" && !items.length ? (
        <Text style={[styles.body, { color: c.muted }]}>Working…</Text>
      ) : null}
    </View>
  );
}
