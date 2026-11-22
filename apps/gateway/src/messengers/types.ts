export interface MessengerAccount {
  id: string;
  ownerUserId: string;
  name: string;
  provider: "slack";
  externalId: string;
  connectorAccountId?: string;
  requiresSlackUser: boolean;
  enabled: boolean;
  status: string;
}

export interface MessengerCredentials {
  appToken: string;
  botToken: string;
}

/** Gateway-only sealed bot authorization. Never returned by runtime credential acquisition. */
export interface SlackBotAuthorization extends MessengerCredentials {
  refreshToken?: string | undefined;
  expiresAt?: number | undefined;
  clientId?: string | undefined;
  appId?: string | undefined;
  teamId?: string | undefined;
}

export interface SaveMessengerAccount {
  /** Verified by the gateway adapter before persisting stand-alone credentials. */
  externalId?: string;
  /** Revision of an existing stand-alone token pair used for validation outside the transaction. */
  validatedRevision?: bigint;
  id?: string;
  connectorAccountId?: string;
  name: string;
  enabled?: boolean;
  appToken?: string;
  botToken?: string;
}

export interface MessengerRoute {
  id: string;
  botId: string;
  accountId: string;
  channelIds: string[];
  userIds: string[];
  directMessages: boolean;
  mentions: boolean;
  observe: boolean;
  delivery: "reply" | "notify";
  instructions: string;
}

export type SaveMessengerRoute = Omit<MessengerRoute, "id"> & { id?: string };

export interface AccountLease {
  accountId: string;
  holder: string;
  token: string;
}

export interface MessengerEvent {
  id: string;
  accountId: string;
  channelId: string;
  /** Empty for the channel root; the provider thread root for replies. */
  threadId: string;
  messageId: string;
  authorId: string;
  text: string;
  fileIds?: readonly string[];
  timestamp: string;
  mention: boolean;
  direct: boolean;
  kind?: "message" | "edit" | "delete";
}

export type RouteIngestOutcome =
  | "buffered"
  | "duplicate_message"
  | "message_updated"
  | "message_deleted"
  | "original_message_ignored"
  | "original_message_missing"
  | "route_not_triggered";

export type MessengerIngestOutcome = RouteIngestOutcome | "bots_disabled" | "duplicate_event" | "no_matching_route";

export interface SteerInput {
  id: string;
  botId: string;
  turnId: string;
  conversationId: string;
  text: string;
}

export interface OutboundMessage {
  id: string;
  accountId: string;
  channelId: string;
  threadId: string;
  text: string;
}

export interface OutboundResult {
  /** Provider explicitly refused the write, so it is known not to have been sent. */
  refused?: boolean;
  sent: boolean;
  retryAfterMs?: number;
  uncertain?: boolean;
}

export interface ConversationContext {
  conversationId: string;
  accountId: string;
  channelId: string;
  threadId: string;
  instructions: string;
  delivery: "reply" | "notify";
}

export interface RouteRow {
  id: string;
  bot_id: string;
  account_id: string;
  channel_ids: string[];
  user_ids: string[];
  direct_messages: boolean;
  mentions: boolean;
  observe: boolean;
  delivery: "reply" | "notify";
  instructions: string;
}

export interface ConversationRow {
  id: string;
  route_id: string;
  channel_id: string;
  thread_id: string;
  open_until: Date;
  first_received_at: Date | null;
  last_received_at: Date | null;
  last_dispatched_at: Date | null;
}
