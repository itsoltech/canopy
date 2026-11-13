import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { turnOrigin } from "@canopy/domain/turn-origin";
import type { Tone } from "@canopy/domain/status-look";
import type { IconName } from "@canopy/ui/icons";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/markdown";
import { styles, useColors, useTypography } from "../../ui/theme";
import { useTone } from "../../ui/tone";
import { AgentMessageBubble } from "./AgentMessageBubble";
import { useTimelineDirectory } from "./directory";
import { BackgroundNoteRow } from "./NoticeRows";
import { BotSender, SenderLabel } from "./SenderLabel";
import { UserMessageView } from "./UserMessageView";
import { MessageAttachments } from "../attachments/MessageAttachments";
import { useMessageActions } from "./useMessageActions";

const ICONS = new Map<string, IconName>([
  ["task", "sparkles"],
  ["message", "chat-bubble-left-right"],
  ["report", "document-text"],
  ["question", "hand-raised"],
  ["schedule", "clock"],
  ["answer", "chat-bubble-left-right"],
]);

const TRIGGERS = new Map([
  ["agent_bus", "From an agent"],
  ["interaction", "A side thread is waiting"],
  ["schedule", "Scheduled"],
  ["goal", "Goal"],
]);

const VERBS = new Map([
  ["task", "Task from"],
  ["report", "Report from"],
  ["answer", "Answer from"],
]);

/**
 * The input of a turn with where it came from (web: TurnInput): you (a plain message), another agent (a task or a
 * message, violet, naming the sender's thread), a report from a thread it follows, a side thread's question, a
 * schedule, a bot, or the platform's note about ended background tasks.
 */
export function TurnInput({ turn }: { turn: ui.Turn }) {
  const c = useColors();
  const type = useTypography();
  const directory = useTimelineDirectory();
  const origin = turnOrigin(turn);
  const fallback = directory.queuedFallback?.(turn.id);

  const fromAgent =
    ["task", "message", "report"].includes(origin.kind) ||
    (origin.kind === "answer" && Boolean(turn.sourceThreadId) && !turn.botId);

  const tone: Tone = origin.kind === "question" ? "amber" : origin.kind === "schedule" ? "sky" : "violet";
  const look = useTone(tone);
  const text = turn.quotes.length ? turn.messageText : turn.messageText || turn.inputText;
  const actions = useMessageActions(turn.messageText, "agent_message", fromAgent);

  if (origin.kind === "background_task") return <BackgroundNoteRow itemIds={origin.itemIds} />;

  if (origin.kind === "user")
    return (
      <UserMessageView
        onEdit={
          !turn.inherited && !turn.rewindId && turn.startedAt && directory.editFrom
            ? () => directory.editFrom?.(turn)
            : undefined
        }
        text={text}
        attachments={turn.attachments}
        quotes={turn.quotes}
        mentions={turn.messageText ? turn.mentions : []}
        note={
          turn.status === "queued"
            ? {
                text: fallback?.reason ? `Queued instead: ${fallback.reason}` : turn.dispatched ? "Starting" : "Queued",
                ...(fallback && { tone: "amber" }),
              }
            : undefined
        }
      />
    );

  const hops = turn.hops > 0 ? `${turn.hops} ${turn.hops === 1 ? "hop" : "hops"}` : undefined;
  const icon = <Icon name={ICONS.get(origin.kind) ?? "sparkles"} size={14} color={look.text} />;

  const line = (children: React.ReactNode) => (
    <Text style={[styles.meta, { flexShrink: 1, color: look.text }]}>{children}</Text>
  );

  const setBy = origin.kind === "schedule" ? origin.setBy : "";

  const source = fromAgent ? (
    <SenderLabel
      verb={VERBS.get(origin.kind) ?? "Message from"}
      threadId={turn.sourceThreadId}
      sender={turn.sender}
      fallback={origin.kind === "report" ? "a thread it follows" : "another thread"}
      color={look.text}
      leading={turn.botId ? undefined : icon}
      trailing={hops}
    />
  ) : origin.kind === "answer" ? (
    turn.botId ? (
      <BotSender verb="Answer from" botId={turn.botId} sender={turn.sender} color={look.text} />
    ) : (
      line("Your answer")
    )
  ) : origin.kind === "question" ? (
    line(`${directory.thread(origin.threadId)?.title || "A side thread"} is waiting for an answer`)
  ) : origin.kind === "schedule" ? (
    line(
      !setBy
        ? "Scheduled task you set"
        : setBy === directory.currentId
          ? "Scheduled task its agent set"
          : `Scheduled task set in ${directory.thread(setBy)?.title || "another thread"}`,
    )
  ) : turn.botId ? (
    <BotSender botId={turn.botId} sender={turn.sender} color={look.text} />
  ) : (
    line(TRIGGERS.get(origin.kind === "other" ? origin.trigger : "") ?? (origin.kind === "other" ? origin.trigger : ""))
  );

  return (
    <View style={{ alignItems: "flex-end", gap: 4 }}>
      <View style={[styles.row, { gap: 6, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: "100%" }]}>
        {!turn.botId && !fromAgent && icon}
        {source}
        {hops && !fromAgent ? <Text style={[styles.meta, { color: c.muted }]}>· {hops}</Text> : null}
      </View>
      {turn.attachments.length > 0 && <MessageAttachments files={turn.attachments} pending={false} />}
      {fromAgent ? (
        <AgentMessageBubble
          text={turn.messageText || "(no message)"}
          label={origin.kind === "report" ? "Show the whole report" : undefined}
          actions={actions.trigger}
        >
          <Markdown
            text={turn.messageText || "(no message)"}
            breaks
            selectable={!actions.available}
            color={look.panel.text}
          />
        </AgentMessageBubble>
      ) : (
        <View
          style={{
            maxWidth: "85%",
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderRadius: 16,
            borderBottomRightRadius: 6,
            borderWidth: 1,
            borderColor: look.panel.ring,
            backgroundColor: look.panel.background,
          }}
        >
          {origin.kind === "question" ? (
            <Text style={[type.body, { color: look.panel.text }]}>
              The agent here answers it; you can answer in the side thread instead.
            </Text>
          ) : (
            <Markdown text={turn.messageText} breaks color={look.panel.text} />
          )}
        </View>
      )}
      {actions.menu}
    </View>
  );
}
