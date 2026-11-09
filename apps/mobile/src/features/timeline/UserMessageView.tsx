import { Pressable, Text, View } from "react-native";
import { MentionKind, type Mention, type ui } from "@canopy/contracts";
import { hasPlatformNote } from "@canopy/domain/platform";
import { withoutIds } from "@canopy/domain/humanize";
import type { IconName } from "@canopy/ui/icons";
import { Icon } from "../../ui/Icon";
import { Spinner } from "../../ui/Badge";
import { styles, useColors } from "../../ui/theme";
import { useTone } from "../../ui/tone";
import { mentionElements } from "../composer/MessageText";
import { Markdown } from "../../ui/markdown";
import { AgentMessageBubble } from "./AgentMessageBubble";
import { SenderLabel } from "./SenderLabel";
import { MessageAttachments } from "../attachments/MessageAttachments";

/** A line above a message: what happens to it (queued, steering into the turn, steered) (web: MessageNote). */
export interface MessageNote {
  readonly text: string;
  /** "spinner" while it is on its way. */
  readonly icon?: IconName | "spinner";
  readonly tone?: "neutral" | "amber";
}

/** A message that joined the turn while the agent worked (delivered steer). */
export const STEERED: MessageNote = { icon: "arrow-turn-down-right", text: "Steered into this turn" };

/** A steer on its way: sent to the worker, or taken by the provider and waiting for the agent's next step. */
export const steeringNote = (steer: ui.Steer): MessageNote =>
  steer.status === "accepted"
    ? { icon: "arrow-turn-down-right", text: "Accepted, joins at the agent's next step" }
    : { icon: "spinner", text: "Steering into the running turn…" };

/**
 * A message you (or another agent, over the agent bus) wrote: the input of a turn, or one steered into it (web:
 * UserMessageView). `note` says what happens to it; `pending` dims it until it reaches the agent. An agent's
 * message is violet and folds to its first line; `sender` names the thread or bot whose agent wrote it.
 */
export function UserMessageView({
  text,
  note,
  pending = false,
  attachments = [],
  mentions = [],
  fromAgent = false,
  sender,
  onActions,
}: {
  text: string;
  note?: MessageNote | undefined;
  pending?: boolean;
  /** Files not placed in the text show as chips above it. */
  attachments?: readonly ui.Attachment[];
  mentions?: readonly Mention[];
  fromAgent?: boolean;
  sender?: ui.AgentSender | undefined;
  /** A queued message's "…": edit or delete it. */
  onActions?: () => void;
}) {
  const c = useColors();
  const violet = useTone("violet").text;
  const amber = useTone("amber").text;
  const agent = fromAgent || Boolean(sender);
  const placed = new Set(mentions.flatMap((m) => (m.kind === MentionKind.ATTACHMENT ? [m.name] : [])));
  const loose = attachments.filter((a) => a.kind === "image" || !placed.has(a.id));
  const body = !mentions.length && hasPlatformNote(text) ? withoutIds(text) : text;
  const color = note?.tone === "amber" ? amber : agent ? violet : c.muted;

  const icon =
    note?.icon === "spinner" ? (
      <Spinner color={color} />
    ) : note || !sender?.botId ? (
      <Icon name={note?.icon ?? "sparkles"} size={14} color={color} />
    ) : null;

  const content = body.trim() ? (
    <Markdown text={body} breaks color={c.text} elements={mentionElements(body, mentions)} />
  ) : null;

  return (
    <View style={{ alignItems: "flex-end", gap: 4 }}>
      {agent || note || onActions ? (
        <View style={[styles.row, { gap: 4, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: "100%" }]}>
          {(agent || note) && !sender ? icon : null}
          {sender ? (
            <SenderLabel
              verb="Message from"
              threadId={sender.threadId}
              sender={sender}
              color={color}
              leading={icon}
              trailing={note?.text}
            />
          ) : agent || note ? (
            <Text style={[styles.meta, { flexShrink: 1, color }]}>
              {[agent && "From an agent", note?.text].filter(Boolean).join(" · ")}
            </Text>
          ) : null}
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
      {loose.length > 0 && <MessageAttachments files={loose} pending={pending} />}
      {content && agent ? (
        <AgentMessageBubble text={body} dim={pending}>
          <AgentText text={body} mentions={mentions} />
        </AgentMessageBubble>
      ) : content ? (
        <View
          style={{
            maxWidth: "85%",
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderRadius: 16,
            borderBottomRightRadius: 6,
            backgroundColor: c.userBubble,
            opacity: pending ? 0.7 : 1,
          }}
        >
          {content}
        </View>
      ) : null}
    </View>
  );
}

function AgentText({ text, mentions }: { text: string; mentions: readonly Mention[] }) {
  const violet = useTone("violet").panel.text;

  return <Markdown text={text} breaks color={violet} elements={mentionElements(text, mentions)} />;
}
