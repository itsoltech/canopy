import type { Mention, ui } from "@canopy/contracts";

/**
 * View model of Bots (agents that live in the gateway). Presentational only: no proto types, so a
 * future contract maps onto these shapes in one place. Times are `Date`s; ids are opaque strings.
 */

/** Someone in a conversation: you or a bot. */
export interface ParticipantView {
  id: string;
  kind: "user" | "bot";
  name: string;
  /** Picture; without one a bot gets its generated mascot and you get your initials. */
  imageUrl?: string | undefined;
  shape?: string | undefined;
  color?: string | undefined;
}

export interface BotView extends ParticipantView {
  kind: "bot";
  /** One line about what the bot does. */
  description?: string | undefined;
}

/**
 * direct: you and one bot; group: you and several bots; watch: two bots talking to each other,
 * which you can read but not write in.
 */
export type ConversationKind = "direct" | "group" | "watch";

export interface ConversationPreview {
  senderId: string;
  /** Markdown of the message; the list shows one line of it. */
  text: string;
  at: Date;
  /** The bot could not reply (the list says so instead of the technical text). */
  failed?: boolean | undefined;
}

export interface ConversationView {
  nodeId?: string | undefined;
  id: string;
  kind: ConversationKind;
  /** Groups have a name; direct and watched chats are named after their bots. */
  title?: string | undefined;
  /** Bots of the conversation; you are implicit (except in `watch`, where you are only a reader). */
  bots: BotView[];
  lastMessage?: ConversationPreview | undefined;
  unread: number;
  /** Pinned conversations sit at the top of the Bots section as large avatars. */
  pinned: boolean;
  archived?: boolean | undefined;
  /** Position among the pinned ones (ascending); ignored when not pinned. */
  pinOrder?: number | undefined;
  /** When the conversation started; orders conversations that have no message yet. */
  createdAt?: Date | undefined;
}

/** A link a bot posted, rendered as a chip under the message. */
export interface LinkView {
  url: string;
  title: string;
  kind: "pull_request" | "issue" | "commit" | "web";
  /** e.g. "canopy#443" or the host. */
  subtitle?: string | undefined;
}

export interface ChatMessageView {
  id: string;
  senderId: string;
  at: Date;
  /** Markdown from bots; your own messages are shown as plain text. */
  text: string;
  mentions?: readonly Mention[] | undefined;
  quotes?: readonly ui.Quote[] | undefined;
  attachments?: readonly ui.Attachment[] | undefined;
  links?: LinkView[] | undefined;
  /** Quoted message this one answers. */
  replyTo?: { senderId: string; excerpt: string } | undefined;
  /** Only your own messages: still sending, or failed to send. */
  delivery?: "sending" | "failed" | undefined;
}

/**
 * Something that happened in the conversation rather than something said: a routine created,
 * deleted or disabled, a message relayed from another bot, a participant joining.
 */
export interface ChatEventView {
  id: string;
  at: Date;
  kind: "routine_created" | "routine_deleted" | "routines_disabled" | "relayed_message" | "joined" | "info";
  /** The line itself, e.g. "Deleted routine". */
  text: string;
  /** What it is about, after a middle dot, e.g. "Canopy: scalenie PR #443 po CI". */
  detail?: string | undefined;
  /** Who did it (a bot id), for the colour of the line. */
  actorId?: string | undefined;
  changes?: readonly { field: string; before: string; after: string }[] | undefined;
}

export interface QuestionOptionView {
  id: string;
  label: string;
  description?: string | undefined;
}

/** A bot asks you to pick one of a few options. */
export interface QuestionView {
  expiresAt?: Date | undefined;
  id: string;
  askedBy: string;
  at: Date;
  prompt: string;
  routineTitle?: string | undefined;
  options: QuestionOptionView[];
  freeText?: boolean | undefined;
  expired?: boolean | undefined;
  /** Set once answered (by you, here or elsewhere): the option, or "" with your own words in `text`; skipped = not answered. */
  answer?: { optionId: string; at: Date; text?: string | undefined; skipped?: boolean | undefined } | undefined;
}

/** A bot asks before it acts: what it wants to do and the details, as labelled fields (never JSON). */
export interface ApprovalView {
  ruleOptions?: readonly { id: string; label: string }[] | undefined;
  allowedByRule?: { id: string; label: string } | undefined;
  threadId?: string | undefined;
  expiresAt?: Date | undefined;
  id: string;
  askedBy: string;
  at: Date;
  /** What it wants to do, e.g. "Sending to Notion". */
  action: string;
  routineTitle?: string | undefined;
  fields: { label: string; value: string }[];
  botProposal?:
    | {
        name: string;
        shape: string;
        color: string;
        model: string;
        effort: string;
        provider: string;
        instance: string;
        approvalPolicy: string;
        webAccess: boolean;
        files: boolean;
        instructions: string;
      }
    | undefined;
  /** pending until you answer; `edited` = you sent your own version back instead of approving. */
  status: "pending" | "approved" | "discarded" | "edited" | "expired";
}

/** A bot could not reply: `detail` is the technical cause (for a tooltip), never shown as a message. */
export interface ChatErrorView {
  id: string;
  botId: string;
  at: Date;
  detail: string;
  code?: string;
  source?: string;
  /** The last thing in the conversation: Retry runs the same message again. */
  retryable: boolean;
}

/**
 * One message of a bot ⇄ bot exchange seen from this conversation's bot: it wrote to (`sent`) or heard
 * from (`received`) the other bot. The chat shows a marker instead of the text; the exchange opens apart.
 */
export interface ChatExchangeView {
  id: string;
  exchangeId: string;
  at: Date;
  counterpartId: string;
  direction: "sent" | "received";
}

/** What a bot is doing right now ("Typing…", "Checking Notion"); `waiting` while a card needs you. */
export interface BotStatusView {
  bot: ParticipantView;
  text: string;
  waiting: boolean;
}

export type ChatEntry =
  | { kind: "message"; message: ChatMessageView }
  | { kind: "event"; event: ChatEventView }
  | { kind: "question"; question: QuestionView }
  | { kind: "approval"; approval: ApprovalView }
  | { kind: "error"; error: ChatErrorView }
  | { kind: "exchange"; exchange: ChatExchangeView };

const entryValue = (entry: ChatEntry): { id: string; at: Date } => {
  switch (entry.kind) {
    case "message":
      return entry.message;
    case "event":
      return entry.event;
    case "question":
      return entry.question;
    case "approval":
      return entry.approval;
    case "error":
      return entry.error;
    case "exchange":
      return entry.exchange;
  }
};

export const entryId = (entry: ChatEntry): string => entryValue(entry).id;

export const entryAt = (entry: ChatEntry): Date => entryValue(entry).at;

/** Name shown for a conversation: the group's title or its bots' names. */
export function conversationTitle(conversation: ConversationView): string {
  if (conversation.title) return conversation.title;
  const names = conversation.bots.map((b) => b.name);

  return conversation.kind === "watch" ? names.join(" ⇄ ") : names.join(", ");
}

/** Where a conversation sits in the list: pinned ones first in pin order (`pinIndex` ≥ 0), then by activity. */
export interface ConversationOrder {
  readonly pinIndex: number;
  /** Time of the newest message either way, or of creation when there is none (ms). */
  readonly activeAt: number;
  readonly name: string;
}

/** Chat-app order shared by web, desktop and mobile: pinned on top, then the most recent conversation first. */
export function compareConversations(a: ConversationOrder, b: ConversationOrder): number {
  const pinnedA = a.pinIndex >= 0;
  const pinnedB = b.pinIndex >= 0;

  if (pinnedA !== pinnedB) return pinnedA ? -1 : 1;

  if (pinnedA) return a.pinIndex - b.pinIndex;

  return b.activeAt - a.activeAt || a.name.localeCompare(b.name);
}

const orderOf = (c: ConversationView): ConversationOrder => ({
  pinIndex: -1,
  activeAt: (c.lastMessage?.at ?? c.createdAt)?.getTime() ?? 0,
  name: conversationTitle(c),
});

/** Latest activity first. */
export const byLatest = (conversations: readonly ConversationView[]): ConversationView[] =>
  [...conversations].sort((a, b) => compareConversations(orderOf(a), orderOf(b)));

export interface ArrangedConversations {
  pinned: ConversationView[];
  others: ConversationView[];
}

/** Pinned ones in pin order, then the rest by latest message. */
export function arrangeConversations(conversations: readonly ConversationView[]): ArrangedConversations {
  const pinned = conversations.filter((c) => c.pinned).sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));

  return { pinned, others: byLatest(conversations.filter((c) => !c.pinned)) };
}
